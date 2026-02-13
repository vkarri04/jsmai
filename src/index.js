import Resolver from "@forge/resolver";
import api, { storage, route } from "@forge/api";

const resolver = new Resolver();
const DEFAULT_AGENT_SETTINGS = { enableChatbot: false, fastApiUrl: "" };

// ─── Shared helpers for portal visibility & project resolution ─────────────────

/**
 * Normalizes project id values to string keys because project settings in
 * Forge Storage are persisted as object keys (string-indexed).
 */
function normalizeProjectId(projectId) {
  if (projectId === null || projectId === undefined) {
    return null;
  }
  const normalized = String(projectId).trim();
  return normalized || null;
}

/**
 * Resolver invocation context can contain richer portal metadata than frontend
 * bridge context. Merge this into payload-derived values for reliability.
 */
function extractPortalContextFromInvocation(context) {
  const extension = context?.extension || {};
  return {
    projectId:
      extension?.project?.id ??
      extension?.portal?.projectId ??
      extension?.request?.projectId ??
      null,
    projectKey:
      extension?.project?.key ??
      extension?.portal?.projectKey ??
      extension?.request?.projectKey ??
      null,
    portalId:
      extension?.portal?.id ??
      extension?.portalId ??
      extension?.request?.portalId ??
      null,
  };
}

/**
 * Portal contexts can provide either project id or project key depending on
 * the page type. This helper resolves and normalizes to one project id value.
 */
async function resolveProjectIdFromContext({ projectId, projectKey, portalId }) {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (normalizedProjectId) {
    return normalizedProjectId;
  }

  const normalizedPortalId = normalizeProjectId(portalId);
  if (normalizedPortalId) {
    try {
      const portalResponse = await api.asApp().requestJira(
        route`/rest/servicedeskapi/servicedesk/${normalizedPortalId}`,
        { headers: { Accept: "application/json" } }
      );

      if (portalResponse.ok) {
        const portalData = await portalResponse.json();
        const portalProjectId = normalizeProjectId(
          portalData?.projectId || portalData?.project?.id
        );
        if (portalProjectId) {
          return portalProjectId;
        }
      }
    } catch {
      // Fall through to key-based resolution when servicedesk lookup is unavailable.
    }
  }

  if (!projectKey) {
    return null;
  }

  try {
    const response = await api
      .asApp()
      .requestJira(route`/rest/api/3/project/${projectKey}?expand=none`, {
        headers: { Accept: "application/json" },
      });

    if (!response.ok) {
      return null;
    }

    const project = await response.json();
    return normalizeProjectId(project?.id);
  } catch {
    return null;
  }
}

/**
 * Centralized policy used by both frontend visibility checks and chat calls.
 * A project must be explicitly enabled in Agent Settings to use portal chat.
 */
async function getPortalChatAvailability({ projectId, projectKey, portalId }) {
  const agentSettings = (await storage.get("agentSettings")) || {};
  const hasExplicitGlobalFlag = Object.prototype.hasOwnProperty.call(agentSettings, "enableChatbot");
  if (hasExplicitGlobalFlag && !agentSettings.enableChatbot) {
    return { enabled: false, reason: "disabled_by_admin" };
  }

  const resolvedProjectId = await resolveProjectIdFromContext({
    projectId,
    projectKey,
    portalId,
  });
  if (!resolvedProjectId) {
    // On some portal pages (for example the portal list), there is no single
    // project in context. Keep the assistant visible and enforce user access
    // with asUser() checks when specific issue lookups are requested.
    return { enabled: true, reason: "missing_project_context", projectId: null };
  }

  const projectSettings = (await storage.get("projectChatSettings")) || {};
  if (!projectSettings[resolvedProjectId]) {
    return { enabled: false, reason: "disabled_for_project", projectId: resolvedProjectId };
  }

  return { enabled: true, projectId: resolvedProjectId };
}

// ─── General Settings ────────────────────────────────────────────────

resolver.define("saveSettings", async ({ payload }) => {
  await storage.set("agentSettings", payload);
  return { success: true };
});

resolver.define("getSettings", async () => {
  const settings = await storage.get("agentSettings");
  return settings || DEFAULT_AGENT_SETTINGS;
});

// ─── Project-level Chat Settings ─────────────────────────────────────

resolver.define("getProjects", async () => {
  try {
    const projectSearchPath = route`/rest/api/3/project/search?typeKey=service_desk&maxResults=100`;
    const requestOptions = { headers: { Accept: "application/json" } };

    // Prefer user-context auth for admin UX; if unavailable, fall back to app-context.
    const requestProjects = async (mode) => {
      const client = mode === "asUser" ? api.asUser() : api.asApp();
      try {
        const response = await client.requestJira(projectSearchPath, requestOptions);
        return { mode, response };
      } catch (error) {
        return { mode, error };
      }
    };

    const asUserAttempt = await requestProjects("asUser");
    let activeAttempt = asUserAttempt;

    const shouldFallbackToApp =
      Boolean(asUserAttempt.error) ||
      asUserAttempt.response?.status === 401 ||
      asUserAttempt.response?.status === 403;

    if (shouldFallbackToApp) {
      const asAppAttempt = await requestProjects("asApp");
      activeAttempt = asAppAttempt.error ? asUserAttempt : asAppAttempt;
    }

    if (activeAttempt.error) {
      return {
        error: `Failed to fetch projects (${activeAttempt.mode}): ${activeAttempt.error.message || String(activeAttempt.error)}`,
      };
    }

    const { mode, response } = activeAttempt;

    if (!response.ok) {
      const text = await response.text();
      return { error: `Failed to fetch projects (${mode}): ${response.status} — ${text}` };
    }

    const data = await response.json();
    const values = data.values || [];

    return {
      projects: values.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        avatarUrl: p.avatarUrls?.["48x48"] || p.avatarUrls?.["32x32"] || "",
      })),
    };
  } catch (err) {
    return { error: `Resolver error: ${err.message || String(err)}` };
  }
});

resolver.define("getProjectChatSettings", async () => {
  const settings = await storage.get("projectChatSettings");
  return settings || {};
});

resolver.define("saveProjectChatSettings", async ({ payload }) => {
  await storage.set("projectChatSettings", payload);
  return { success: true };
});

resolver.define("getPortalChatAvailability", async ({ payload, context }) => {
  const invocationContext = extractPortalContextFromInvocation(context);
  const projectId = payload?.projectId ?? invocationContext.projectId;
  const projectKey = payload?.projectKey ?? invocationContext.projectKey;
  const portalId = payload?.portalId ?? invocationContext.portalId;
  return getPortalChatAvailability({ projectId, projectKey, portalId });
});

// ─── LLM / AI Model Settings ────────────────────────────────────────

resolver.define("getLLMSettings", async () => {
  const settings = await storage.get("llmSettings");
  return settings || { provider: "openai", model: "", apiKey: "" };
});

resolver.define("saveLLMSettings", async ({ payload }) => {
  const { provider, model, apiKey } = payload;

  if (!provider || !["openai", "claude"].includes(provider)) {
    return { error: "Invalid provider. Must be 'openai' or 'claude'." };
  }
  if (!model) {
    return { error: "Model is required." };
  }
  if (!apiKey) {
    return { error: "API key is required." };
  }

  await storage.set("llmSettings", { provider, model, apiKey });
  return { success: true };
});

// ─── Chat ────────────────────────────────────────────────────────────

resolver.define("chat", async ({ payload }) => {
  const settings = await storage.get("agentSettings");

  if (!settings?.enableChatbot) {
    return { error: "Chatbot is disabled by admin." };
  }

  if (!settings?.fastApiUrl) {
    return { error: "FastAPI URL not configured." };
  }

  // Check project-level setting if projectId is provided
  if (payload?.projectId) {
    const projectSettings = await storage.get("projectChatSettings");
    if (projectSettings && !projectSettings[payload.projectId]) {
      return { error: "Chat agent is not enabled for this project." };
    }
  }

  // Retrieve LLM settings and include them in the backend request
  const llmSettings = await storage.get("llmSettings");
  const chatPayload = {
    ...payload,
    llm: llmSettings
      ? { provider: llmSettings.provider, model: llmSettings.model, apiKey: llmSettings.apiKey }
      : undefined,
  };

  const response = await fetch(`${settings.fastApiUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chatPayload),
  });

  const data = await response.json();
  return data;
});

// ─── Issue Details ──────────────────────────────────────────────────

resolver.define("getIssueDetails", async ({ payload }) => {
  const { issueKey } = payload;

  if (!issueKey) {
    return { error: "Issue key is required." };
  }

  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=status,assignee,reporter,summary`,
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) {
      const text = await response.text();
      if (response.status === 404) {
        return { error: `Issue ${issueKey} was not found.` };
      }
      return { error: `Failed to fetch issue: ${response.status} — ${text}` };
    }

    const data = await response.json();
    const fields = data.fields || {};

    return {
      issueKey: data.key,
      summary: fields.summary || "",
      status: fields.status?.name || "Unknown",
      statusCategory: fields.status?.statusCategory?.name || "",
      assignee: fields.assignee
        ? { displayName: fields.assignee.displayName, emailAddress: fields.assignee.emailAddress }
        : null,
      reporter: fields.reporter
        ? { displayName: fields.reporter.displayName, emailAddress: fields.reporter.emailAddress }
        : null,
    };
  } catch (err) {
    return { error: `Failed to fetch issue details: ${err.message || String(err)}` };
  }
});

// ─── Portal Chat (Jira Assistant) ───────────────────────────────────

resolver.define("portalChat", async ({ payload, context }) => {
  const invocationContext = extractPortalContextFromInvocation(context);
  const { message } = payload || {};

  if (!message || !message.trim()) {
    return { reply: "Please enter a message." };
  }

  const availability = await getPortalChatAvailability({
    projectId: payload?.projectId ?? invocationContext.projectId,
    projectKey: payload?.projectKey ?? invocationContext.projectKey,
    portalId: payload?.portalId ?? invocationContext.portalId,
  });
  if (!availability.enabled) {
    return { reply: "Jira Assistant is disabled for this portal project. Please contact your administrator." };
  }

  const resolvedProjectId = availability.projectId;

  // Get LLM settings
  const llmSettings = await storage.get("llmSettings");
  if (!llmSettings?.apiKey) {
    return { reply: "AI is not configured yet. Please ask your administrator to set up the AI model in Agent Settings." };
  }

  // Step 1: Use Claude to interpret the user message and extract issue keys
  const extractionPrompt = `You are a Jira Assistant. Analyze the user's message and extract any Jira issue keys mentioned.
Jira issue keys follow the pattern: PROJECT-NUMBER (e.g., TJ-1, PROJ-123, ABC-42).

User message: "${message}"

Respond ONLY with a JSON object in this exact format (no markdown, no code fences):
{"issueKeys": ["TJ-1"], "intent": "status"}

Rules for "intent":
- "status" = user wants to know the status, what's going on, or general info about the issue
- "assignee" = user specifically asks who is assigned or working on it
- "reporter" = user specifically asks who reported or created the issue
- "all" = user asks for multiple details or general info (status, assignee, reporter)

If no issue key is found, respond with:
{"issueKeys": [], "intent": "none"}`;

  try {
    let extractionResult;

    if (llmSettings.provider === "claude") {
      const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": llmSettings.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: llmSettings.model,
          max_tokens: 200,
          messages: [{ role: "user", content: extractionPrompt }],
        }),
      });

      if (!claudeResponse.ok) {
        const errText = await claudeResponse.text();
        return { reply: `AI service error: ${claudeResponse.status}. Please check your API key configuration.` };
      }

      const claudeData = await claudeResponse.json();
      const responseText = claudeData.content?.[0]?.text || "";
      extractionResult = JSON.parse(responseText);
    } else {
      // OpenAI
      const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llmSettings.apiKey}`,
        },
        body: JSON.stringify({
          model: llmSettings.model,
          max_tokens: 200,
          messages: [
            { role: "system", content: "You are a helpful assistant that extracts Jira issue keys from user messages." },
            { role: "user", content: extractionPrompt },
          ],
        }),
      });

      if (!openaiResponse.ok) {
        return { reply: "AI service error. Please check your API key configuration." };
      }

      const openaiData = await openaiResponse.json();
      const responseText = openaiData.choices?.[0]?.message?.content || "";
      extractionResult = JSON.parse(responseText);
    }

    const { issueKeys, intent } = extractionResult;

    // No issue keys found
    if (!issueKeys || issueKeys.length === 0) {
      return {
        reply: "I'm your Jira Assistant! I can help you check the status, assignee, and reporter of Jira issues.\n\nTry asking me something like:\n• \"What is the status of TJ-1?\"\n• \"Who is assigned to PROJ-42?\"\n• \"Tell me about ABC-10\"",
      };
    }

    // Step 2: Fetch issue details for each issue key
    const issueResults = [];
    for (const key of issueKeys) {
      let response;
      try {
        // Use user-scoped Jira calls so portal customers only get issues they
        // are actually allowed to read in Jira Service Management.
        response = await api.asUser().requestJira(
          route`/rest/api/3/issue/${key}?fields=project,status,assignee,reporter,summary`,
          { headers: { Accept: "application/json" } }
        );
      } catch {
        issueResults.push({ issueKey: key, error: "not accessible" });
        continue;
      }

      if (!response.ok) {
        issueResults.push({
          issueKey: key,
          error: response.status === 404 ? "not found" : response.status === 403 ? "not accessible" : "fetch error",
        });
        continue;
      }

      const data = await response.json();
      const fields = data.fields || {};

      // Extra safety guard: even if a key is valid, only answer for the same
      // portal project that the customer is currently browsing.
      const issueProjectId = normalizeProjectId(fields.project?.id);
      if (resolvedProjectId && (!issueProjectId || issueProjectId !== resolvedProjectId)) {
        issueResults.push({ issueKey: key, error: "not in this portal project" });
        continue;
      }

      issueResults.push({
        issueKey: data.key,
        summary: fields.summary || "",
        status: fields.status?.name || "Unknown",
        statusCategory: fields.status?.statusCategory?.name || "",
        assignee: fields.assignee?.displayName || "Unassigned",
        reporter: fields.reporter?.displayName || "Unknown",
      });
    }

    // Step 3: Use Claude to generate a natural language response
    const issueContext = issueResults
      .map((r) => {
        if (r.error) return `${r.issueKey}: ${r.error}`;
        return `${r.issueKey}: Summary="${r.summary}", Status="${r.status}" (${r.statusCategory}), Assignee="${r.assignee}", Reporter="${r.reporter}"`;
      })
      .join("\n");

    const responsePrompt = `You are Jira Assistant, a friendly and concise chatbot on a Jira Service Management Customer Portal.
The user asked: "${message}"
Their intent is: "${intent}"

Here is the issue data:
${issueContext}

Respond naturally and concisely. Format the response clearly. If the intent is "status", focus on the status. If "assignee", focus on who it's assigned to. If "reporter", focus on who reported it. If "all" or "status" with a general question, include status, assignee, and reporter.
If an issue was not found, let the user know politely.
Do NOT use markdown headers. Keep it conversational but informative.`;

    let naturalReply;

    if (llmSettings.provider === "claude") {
      const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": llmSettings.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: llmSettings.model,
          max_tokens: 500,
          messages: [{ role: "user", content: responsePrompt }],
        }),
      });

      if (!claudeResponse.ok) {
        // Fallback to structured response
        naturalReply = formatFallbackReply(issueResults, intent);
      } else {
        const claudeData = await claudeResponse.json();
        naturalReply = claudeData.content?.[0]?.text || formatFallbackReply(issueResults, intent);
      }
    } else {
      const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llmSettings.apiKey}`,
        },
        body: JSON.stringify({
          model: llmSettings.model,
          max_tokens: 500,
          messages: [
            { role: "system", content: "You are Jira Assistant, a concise and friendly chatbot." },
            { role: "user", content: responsePrompt },
          ],
        }),
      });

      if (!openaiResponse.ok) {
        naturalReply = formatFallbackReply(issueResults, intent);
      } else {
        const openaiData = await openaiResponse.json();
        naturalReply = openaiData.choices?.[0]?.message?.content || formatFallbackReply(issueResults, intent);
      }
    }

    return { reply: naturalReply };
  } catch (err) {
    return { reply: `Something went wrong: ${err.message || String(err)}` };
  }
});

function formatFallbackReply(issueResults, intent) {
  return issueResults
    .map((r) => {
      if (r.error) return `${r.issueKey}: Could not be found.`;
      const parts = [`${r.issueKey} — ${r.summary}`];
      if (intent === "status" || intent === "all") parts.push(`Status: ${r.status}`);
      if (intent === "assignee" || intent === "all") parts.push(`Assignee: ${r.assignee}`);
      if (intent === "reporter" || intent === "all") parts.push(`Reporter: ${r.reporter}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

export const handler = resolver.getDefinitions();
