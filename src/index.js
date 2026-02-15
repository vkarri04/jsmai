import Resolver from "@forge/resolver";
import api, { storage, route } from "@forge/api";

const resolver = new Resolver();
const DEFAULT_AGENT_SETTINGS = { enableChatbot: false, fastApiUrl: "" };
const LLM_SETTINGS_STORAGE_KEY = "llmSettings";
const LLM_API_KEY_SECRET_STORAGE_KEY = "llmSettingsApiKey";
const DEFAULT_LLM_SETTINGS = { provider: "openai", model: "" };
const PORTAL_CHAT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PORTAL_CHAT_RATE_LIMIT_MAX_REQUESTS = 20;

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

/**
 * Loads service desks visible to the current portal user. This powers dynamic
 * request creation where users pick a project first.
 */
async function fetchAccessibleServiceDesksAsUser() {
  const values = [];
  let start = 0;
  const limit = 50;

  try {
    while (true) {
      const response = await api.asUser().requestJira(
        route`/rest/servicedeskapi/servicedesk?start=${start}&limit=${limit}`,
        { headers: { Accept: "application/json" } }
      );

      if (!response.ok) {
        const text = await response.text();
        return { error: `Failed to fetch service desks: ${response.status} — ${text}` };
      }

      const data = await response.json();
      const pageValues = Array.isArray(data.values) ? data.values : [];
      values.push(...pageValues);

      const size = Number(data.size || pageValues.length || 0);
      const total = Number(data.total || 0);
      const reachedLastPage =
        Boolean(data.isLastPage) ||
        pageValues.length === 0 ||
        (total > 0 && start + size >= total);

      if (reachedLastPage) {
        break;
      }

      start += size > 0 ? size : pageValues.length;
      if (start <= 0) {
        break;
      }
    }

    return { values };
  } catch (err) {
    return { error: `Failed to fetch service desks: ${err.message || String(err)}` };
  }
}

/**
 * Converts raw service desk API values into a consistent shape used by UI.
 */
function mapServiceDeskSummary(serviceDesk) {
  return {
    serviceDeskId: String(serviceDesk?.id || ""),
    projectId: normalizeProjectId(serviceDesk?.projectId || serviceDesk?.project?.id),
    projectKey: serviceDesk?.projectKey || serviceDesk?.project?.key || "",
    projectName:
      serviceDesk?.projectName ||
      serviceDesk?.project?.name ||
      serviceDesk?.name ||
      "Service project",
    portalName: serviceDesk?.name || serviceDesk?.projectName || "Customer portal",
  };
}

/**
 * Returns service desks that the current user can access AND that admins have
 * enabled for this assistant. If the current page has a single portal context,
 * it is restricted to that project.
 */
async function getAllowedPortalServiceDesks({ projectId, projectKey, portalId }) {
  const availability = await getPortalChatAvailability({ projectId, projectKey, portalId });
  if (!availability.enabled) {
    return { error: "Jira Assistant is disabled for this portal project.", serviceDesks: [] };
  }

  const serviceDeskResult = await fetchAccessibleServiceDesksAsUser();
  if (serviceDeskResult.error) {
    return { error: serviceDeskResult.error, serviceDesks: [] };
  }

  const restrictProjectId = availability.projectId || null;
  const projectSettings = (await storage.get("projectChatSettings")) || {};

  const serviceDesks = (serviceDeskResult.values || [])
    .map(mapServiceDeskSummary)
    .filter((desk) => Boolean(desk.serviceDeskId && desk.projectId))
    .filter((desk) => Boolean(projectSettings[desk.projectId]))
    .filter((desk) => (restrictProjectId ? desk.projectId === restrictProjectId : true));

  return { serviceDesks };
}

/**
 * Checks that a requested service desk is available for the current portal
 * context and admin project settings.
 */
async function ensureAllowedServiceDesk(serviceDeskId, context) {
  const normalizedServiceDeskId =
    serviceDeskId === null || serviceDeskId === undefined ? "" : String(serviceDeskId).trim();

  if (!normalizedServiceDeskId) {
    return { error: "Service desk id is required." };
  }

  const allowed = await getAllowedPortalServiceDesks(context);
  if (allowed.error) {
    return { error: allowed.error };
  }

  const serviceDesk = (allowed.serviceDesks || []).find(
    (candidate) => candidate.serviceDeskId === normalizedServiceDeskId
  );

  if (!serviceDesk) {
    return {
      error: "This portal project is unavailable. Please select a project enabled in Agent Settings.",
    };
  }

  return { serviceDesk };
}

async function fetchRequestTypesForServiceDesk(serviceDeskId) {
  try {
    const response = await api.asUser().requestJira(
      route`/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype?start=0&limit=100`,
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) {
      const text = await response.text();
      return { error: `Failed to fetch request types: ${response.status} — ${text}` };
    }

    const data = await response.json();
    return { values: Array.isArray(data.values) ? data.values : [] };
  } catch (err) {
    return { error: `Failed to fetch request types: ${err.message || String(err)}` };
  }
}

async function fetchRequestTypeFields(serviceDeskId, requestTypeId) {
  try {
    const response = await api.asUser().requestJira(
      route`/rest/servicedeskapi/servicedesk/${serviceDeskId}/requesttype/${requestTypeId}/field`,
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) {
      const text = await response.text();
      return { error: `Failed to fetch request type fields: ${response.status} — ${text}` };
    }

    const data = await response.json();
    const requestTypeFields = Array.isArray(data.requestTypeFields)
      ? data.requestTypeFields
      : Array.isArray(data.values)
      ? data.values
      : [];

    return { values: requestTypeFields };
  } catch (err) {
    return { error: `Failed to fetch request type fields: ${err.message || String(err)}` };
  }
}

function inferPortalFieldInputType(field) {
  const schema = field?.jiraSchema || {};
  const hasOptions = Array.isArray(field?.validValues) && field.validValues.length > 0;

  if (hasOptions) {
    return schema.type === "array" ? "multi_select" : "select";
  }
  if (schema.type === "number") {
    return "number";
  }
  if (schema.type === "date") {
    return "date";
  }
  if (schema.type === "datetime") {
    return "datetime";
  }
  if (field?.fieldId === "description") {
    return "textarea";
  }
  return "text";
}

function normalizeValidValueOption(option) {
  if (option === null || option === undefined) {
    return null;
  }

  if (typeof option !== "object") {
    return { label: String(option), value: String(option) };
  }

  const label =
    option.label ??
    option.name ??
    option.value ??
    option.displayName ??
    option.title ??
    null;

  if (!label) {
    return null;
  }

  return {
    label: String(label),
    id: option.id !== undefined && option.id !== null ? String(option.id) : undefined,
    value:
      option.value !== undefined && option.value !== null
        ? String(option.value)
        : option.key !== undefined && option.key !== null
        ? String(option.key)
        : undefined,
    accountId:
      option.accountId !== undefined && option.accountId !== null
        ? String(option.accountId)
        : undefined,
  };
}

function normalizePortalField(field) {
  const jiraSchema = field?.jiraSchema || {};
  const options = Array.isArray(field?.validValues)
    ? field.validValues
        .map(normalizeValidValueOption)
        .filter(Boolean)
        .slice(0, 100)
    : [];

  return {
    fieldId: field?.fieldId || "",
    name: field?.name || field?.fieldId || "Field",
    description: field?.description || "",
    required: Boolean(field?.required),
    visible: field?.visible !== false,
    inputType: inferPortalFieldInputType(field),
    validValues: options,
    jiraSchema: {
      type: jiraSchema.type || "",
      system: jiraSchema.system || "",
      custom: jiraSchema.custom || "",
      items: jiraSchema.items || "",
    },
  };
}

function normalizeOptionPayload(option) {
  if (!option || typeof option !== "object") {
    return option;
  }
  if (option.accountId) {
    return { accountId: String(option.accountId) };
  }
  if (option.id !== undefined && option.id !== null && option.id !== "") {
    return { id: String(option.id) };
  }
  if (option.value !== undefined && option.value !== null && option.value !== "") {
    return { value: String(option.value) };
  }
  if (option.name !== undefined && option.name !== null && option.name !== "") {
    return { name: String(option.name) };
  }
  if (option.label !== undefined && option.label !== null && option.label !== "") {
    return { value: String(option.label) };
  }
  return option;
}

function matchValidValueOption(validValues, answerText) {
  const normalizedAnswer = String(answerText || "").trim().toLowerCase();
  if (!normalizedAnswer) {
    return null;
  }

  return (
    validValues.find((option, index) => {
      const label = String(option.label || "").trim().toLowerCase();
      const id = String(option.id || "").trim().toLowerCase();
      const value = String(option.value || "").trim().toLowerCase();
      const numericIndex = String(index + 1);
      return (
        normalizedAnswer === label ||
        normalizedAnswer === id ||
        normalizedAnswer === value ||
        normalizedAnswer === numericIndex
      );
    }) || null
  );
}

function convertFieldAnswerToRequestValue(field, answer) {
  if (answer === undefined || answer === null) {
    return undefined;
  }

  const schema = field?.jiraSchema || {};
  const validValues = Array.isArray(field?.validValues) ? field.validValues : [];

  if (typeof answer === "object") {
    if (Array.isArray(answer)) {
      return answer
        .map((item) => normalizeOptionPayload(item))
        .filter((item) => item !== undefined && item !== null);
    }
    const normalizedObject = normalizeOptionPayload(answer);
    if (normalizedObject === undefined || normalizedObject === null) {
      return undefined;
    }
    return schema.type === "array" ? [normalizedObject] : normalizedObject;
  }

  const normalizedAnswer = String(answer).trim();
  if (!normalizedAnswer) {
    return undefined;
  }

  if (validValues.length > 0) {
    const matchedOption = matchValidValueOption(validValues, normalizedAnswer);
    if (matchedOption) {
      const normalizedOption = normalizeOptionPayload(matchedOption);
      return schema.type === "array" ? [normalizedOption] : normalizedOption;
    }
  }

  if (schema.type === "number") {
    const numericValue = Number(normalizedAnswer);
    return Number.isFinite(numericValue) ? numericValue : normalizedAnswer;
  }

  if (schema.type === "array") {
    return normalizedAnswer
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return normalizedAnswer;
}

function maskApiKey(apiKey) {
  const normalized = String(apiKey || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 8) {
    return `${normalized.slice(0, 2)}${"*".repeat(Math.max(0, normalized.length - 2))}`;
  }
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

/**
 * Backward-compatible migration for earlier releases where API keys were
 * stored in plaintext in regular storage. Moves key into encrypted storage.
 */
async function migrateLegacyLlmApiKeyIfNeeded() {
  const settings = (await storage.get(LLM_SETTINGS_STORAGE_KEY)) || {};
  const legacyApiKey =
    typeof settings.apiKey === "string" ? settings.apiKey.trim() : "";

  if (!legacyApiKey) {
    return;
  }

  await storage.setSecret(LLM_API_KEY_SECRET_STORAGE_KEY, legacyApiKey);
  const { apiKey, ...nonSecretSettings } = settings;
  await storage.set(LLM_SETTINGS_STORAGE_KEY, nonSecretSettings);
}

async function getLlmRuntimeSettings() {
  await migrateLegacyLlmApiKeyIfNeeded();

  const storedSettings = (await storage.get(LLM_SETTINGS_STORAGE_KEY)) || {};
  const provider = ["openai", "claude"].includes(storedSettings.provider)
    ? storedSettings.provider
    : DEFAULT_LLM_SETTINGS.provider;
  const model =
    typeof storedSettings.model === "string" ? storedSettings.model : "";
  const apiKeySecret = await storage.getSecret(LLM_API_KEY_SECRET_STORAGE_KEY);
  const apiKey =
    typeof apiKeySecret === "string" ? apiKeySecret.trim() : "";

  return { provider, model, apiKey };
}

async function getLlmSettingsForAdmin() {
  const runtimeSettings = await getLlmRuntimeSettings();
  const apiKeyMasked = maskApiKey(runtimeSettings.apiKey);

  return {
    provider: runtimeSettings.provider || DEFAULT_LLM_SETTINGS.provider,
    model: runtimeSettings.model || "",
    apiKey: apiKeyMasked,
    apiKeyMasked,
    hasApiKey: Boolean(runtimeSettings.apiKey),
  };
}

async function saveLlmSettingsSecurely({ provider, model, apiKey }) {
  if (!provider || !["openai", "claude"].includes(provider)) {
    return { error: "Invalid provider. Must be 'openai' or 'claude'." };
  }
  if (!model) {
    return { error: "Model is required." };
  }

  const runtimeSettings = await getLlmRuntimeSettings();
  const submittedApiKey =
    typeof apiKey === "string" ? apiKey.trim() : "";
  const existingMaskedApiKey = maskApiKey(runtimeSettings.apiKey);
  const shouldKeepExistingApiKey =
    Boolean(runtimeSettings.apiKey) &&
    (!submittedApiKey || submittedApiKey === existingMaskedApiKey);

  const nextApiKey = shouldKeepExistingApiKey
    ? runtimeSettings.apiKey
    : submittedApiKey;

  if (!nextApiKey) {
    return { error: "API key is required." };
  }

  await storage.set(LLM_SETTINGS_STORAGE_KEY, { provider, model });
  if (!shouldKeepExistingApiKey || !runtimeSettings.apiKey) {
    await storage.setSecret(LLM_API_KEY_SECRET_STORAGE_KEY, nextApiKey);
  }

  return {
    success: true,
    provider,
    model,
    apiKeyMasked: maskApiKey(nextApiKey),
    hasApiKey: true,
  };
}

/**
 * Shared provider abstraction to avoid duplicated OpenAI/Claude branches and
 * to centralize parsing/error handling.
 */
async function callLlmText({ llmSettings, systemPrompt, userMessage, maxTokens = 500 }) {
  if (!llmSettings?.provider || !llmSettings?.model || !llmSettings?.apiKey) {
    return { error: "AI settings are incomplete." };
  }

  try {
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
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        }),
      });

      if (!claudeResponse.ok) {
        const errorText = await claudeResponse.text();
        return {
          error: `AI service error: ${claudeResponse.status} — ${errorText || "Unknown error"}`,
        };
      }

      const claudeData = await claudeResponse.json();
      const text = Array.isArray(claudeData.content)
        ? claudeData.content
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("\n")
            .trim()
        : "";

      return text ? { text } : { error: "AI service returned an empty response." };
    }

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmSettings.apiKey}`,
      },
      body: JSON.stringify({
        model: llmSettings.model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      return {
        error: `AI service error: ${openaiResponse.status} — ${errorText || "Unknown error"}`,
      };
    }

    const openaiData = await openaiResponse.json();
    const text = openaiData.choices?.[0]?.message?.content?.trim() || "";
    return text ? { text } : { error: "AI service returned an empty response." };
  } catch (err) {
    return { error: `AI service error: ${err.message || String(err)}` };
  }
}

function getPortalChatRequesterId(context) {
  const extension = context?.extension || {};
  return (
    context?.accountId ||
    context?.principal?.accountId ||
    extension?.request?.customer?.accountId ||
    extension?.request?.accountId ||
    extension?.request?.requester?.accountId ||
    context?.localId ||
    "anonymous"
  );
}

async function checkPortalChatRateLimit(context) {
  const requesterId = getPortalChatRequesterId(context);
  const rateLimitKey = `portalChatRate:${requesterId}`;
  const now = Date.now();

  try {
    const existingState = (await storage.get(rateLimitKey)) || {};
    let windowStart = Number(existingState.windowStart || 0);
    let count = Number(existingState.count || 0);

    if (!windowStart || now - windowStart >= PORTAL_CHAT_RATE_LIMIT_WINDOW_MS) {
      windowStart = now;
      count = 1;
      await storage.set(rateLimitKey, { windowStart, count });
      return { allowed: true };
    }

    if (count >= PORTAL_CHAT_RATE_LIMIT_MAX_REQUESTS) {
      const retryAfterMs = Math.max(
        0,
        PORTAL_CHAT_RATE_LIMIT_WINDOW_MS - (now - windowStart)
      );
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    count += 1;
    await storage.set(rateLimitKey, { windowStart, count });
    return { allowed: true };
  } catch {
    // If rate limit state cannot be read/written, allow the request to avoid
    // blocking legitimate users due to transient storage issues.
    return { allowed: true };
  }
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

// ─── Portal Request Creation (Dynamic Intake) ───────────────────────

resolver.define("getPortalCreateRequestProjects", async ({ payload, context }) => {
  const invocationContext = extractPortalContextFromInvocation(context);
  const projectId = payload?.projectId ?? invocationContext.projectId;
  const projectKey = payload?.projectKey ?? invocationContext.projectKey;
  const portalId = payload?.portalId ?? invocationContext.portalId;

  const allowedServiceDesks = await getAllowedPortalServiceDesks({
    projectId,
    projectKey,
    portalId,
  });

  if (allowedServiceDesks.error) {
    return { projects: [], error: allowedServiceDesks.error };
  }

  return {
    projects: (allowedServiceDesks.serviceDesks || []).map((serviceDesk) => ({
      serviceDeskId: serviceDesk.serviceDeskId,
      projectId: serviceDesk.projectId,
      projectKey: serviceDesk.projectKey,
      projectName: serviceDesk.projectName,
      portalName: serviceDesk.portalName,
    })),
  };
});

resolver.define("getPortalRequestTypes", async ({ payload, context }) => {
  const invocationContext = extractPortalContextFromInvocation(context);
  const projectId = payload?.projectId ?? invocationContext.projectId;
  const projectKey = payload?.projectKey ?? invocationContext.projectKey;
  const portalId = payload?.portalId ?? invocationContext.portalId;

  const allowedServiceDesk = await ensureAllowedServiceDesk(payload?.serviceDeskId, {
    projectId,
    projectKey,
    portalId,
  });
  if (allowedServiceDesk.error) {
    return { requestTypes: [], error: allowedServiceDesk.error };
  }

  const requestTypeResult = await fetchRequestTypesForServiceDesk(
    allowedServiceDesk.serviceDesk.serviceDeskId
  );
  if (requestTypeResult.error) {
    return { requestTypes: [], error: requestTypeResult.error };
  }

  return {
    requestTypes: (requestTypeResult.values || []).map((requestType) => ({
      id: String(requestType.id || ""),
      name: requestType.name || "Request type",
      description: requestType.description || "",
      helpText: requestType.helpText || "",
      issueTypeName: requestType.issueTypeName || "",
    })),
  };
});

resolver.define("getPortalRequestTypeFields", async ({ payload, context }) => {
  const invocationContext = extractPortalContextFromInvocation(context);
  const projectId = payload?.projectId ?? invocationContext.projectId;
  const projectKey = payload?.projectKey ?? invocationContext.projectKey;
  const portalId = payload?.portalId ?? invocationContext.portalId;

  const requestTypeId =
    payload?.requestTypeId === null || payload?.requestTypeId === undefined
      ? ""
      : String(payload.requestTypeId).trim();
  if (!requestTypeId) {
    return { fields: [], error: "Request type id is required." };
  }

  const allowedServiceDesk = await ensureAllowedServiceDesk(payload?.serviceDeskId, {
    projectId,
    projectKey,
    portalId,
  });
  if (allowedServiceDesk.error) {
    return { fields: [], error: allowedServiceDesk.error };
  }

  const fieldResult = await fetchRequestTypeFields(
    allowedServiceDesk.serviceDesk.serviceDeskId,
    requestTypeId
  );
  if (fieldResult.error) {
    return { fields: [], error: fieldResult.error };
  }

  const allVisibleFields = (fieldResult.values || []).filter(
    (field) => field?.visible !== false
  );

  const allowsAttachments = allVisibleFields.some(
    (field) => field?.fieldId === "attachment"
  );

  const normalizedFields = (fieldResult.values || [])
    .map(normalizePortalField)
    .filter((field) => field.visible && field.required && field.fieldId !== "attachment");

  return { fields: normalizedFields, allowsAttachments };
});

resolver.define("createPortalRequest", async ({ payload, context }) => {
  const invocationContext = extractPortalContextFromInvocation(context);
  const projectId = payload?.projectId ?? invocationContext.projectId;
  const projectKey = payload?.projectKey ?? invocationContext.projectKey;
  const portalId = payload?.portalId ?? invocationContext.portalId;

  const requestTypeId =
    payload?.requestTypeId === null || payload?.requestTypeId === undefined
      ? ""
      : String(payload.requestTypeId).trim();
  if (!requestTypeId) {
    return { error: "Request type id is required." };
  }

  const allowedServiceDesk = await ensureAllowedServiceDesk(payload?.serviceDeskId, {
    projectId,
    projectKey,
    portalId,
  });
  if (allowedServiceDesk.error) {
    return { error: allowedServiceDesk.error };
  }

  const fieldResult = await fetchRequestTypeFields(
    allowedServiceDesk.serviceDesk.serviceDeskId,
    requestTypeId
  );
  if (fieldResult.error) {
    return { error: fieldResult.error };
  }

  const visibleFields = (fieldResult.values || []).filter((field) => field?.visible !== false);
  const allowsAttachments = visibleFields.some((field) => field?.fieldId === "attachment");
  const requiredFields = visibleFields.filter(
    (field) => Boolean(field?.required) && field?.fieldId !== "attachment"
  );

  const fieldAnswers =
    payload?.fieldAnswers && typeof payload.fieldAnswers === "object" ? payload.fieldAnswers : {};
  const requestFieldValues = {};
  const missingFields = [];

  for (const field of requiredFields) {
    const answer = fieldAnswers[field.fieldId];
    const converted = convertFieldAnswerToRequestValue(field, answer);
    const isMissing = converted === undefined || (Array.isArray(converted) && converted.length === 0);

    if (isMissing) {
      missingFields.push(field.name || field.fieldId);
      continue;
    }

    requestFieldValues[field.fieldId] = converted;
  }

  // Include optional answers if the field is visible in this request type.
  for (const [fieldId, answer] of Object.entries(fieldAnswers)) {
    if (Object.prototype.hasOwnProperty.call(requestFieldValues, fieldId)) {
      continue;
    }
    const field = visibleFields.find((candidate) => candidate.fieldId === fieldId);
    if (!field || field.fieldId === "attachment") {
      continue;
    }
    const converted = convertFieldAnswerToRequestValue(field, answer);
    if (converted !== undefined && (!Array.isArray(converted) || converted.length > 0)) {
      requestFieldValues[fieldId] = converted;
    }
  }

  if (missingFields.length > 0) {
    return { error: `Missing required fields: ${missingFields.join(", ")}` };
  }

  const temporaryAttachmentIds = Array.isArray(payload?.temporaryAttachmentIds)
    ? payload.temporaryAttachmentIds
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    : [];
  const attachmentIdsForPayload = allowsAttachments ? temporaryAttachmentIds : [];

  const createBody = {
    serviceDeskId: allowedServiceDesk.serviceDesk.serviceDeskId,
    requestTypeId,
    requestFieldValues,
  };
  if (attachmentIdsForPayload.length > 0) {
    createBody.temporaryAttachmentIds = attachmentIdsForPayload;
  }

  try {
    const createAttempt = async (body) => {
      const response = await api.asUser().requestJira(route`/rest/servicedeskapi/request`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const rawText = await response.text();
      let parsedBody = null;
      if (rawText) {
        try {
          parsedBody = JSON.parse(rawText);
        } catch {
          parsedBody = null;
        }
      }

      return { ok: response.ok, status: response.status, rawText, parsedBody };
    };

    const formatCreateError = (attempt) => {
      const parsed = attempt?.parsedBody;
      const errorMessages = Array.isArray(parsed?.errorMessages)
        ? parsed.errorMessages.filter(Boolean)
        : [];
      const fieldErrors =
        parsed?.errors && typeof parsed.errors === "object"
          ? Object.entries(parsed.errors)
              .map(([fieldId, message]) => `${fieldId}: ${message}`)
              .filter(Boolean)
          : [];

      const detail = [...errorMessages, ...fieldErrors].join("; ");
      if (detail) {
        return `Failed to create request: ${attempt.status} — ${detail}`;
      }
      return `Failed to create request: ${attempt.status} — ${attempt.rawText || "Unknown error"}`;
    };

    let finalAttempt = await createAttempt(createBody);
    let attachmentWarning = "";
    let createdWithoutAttachmentPayload = false;

    // If the payload fails while attachments are present, retry once without
    // attachment ids so request creation still succeeds for stricter request types.
    if (!finalAttempt.ok && attachmentIdsForPayload.length > 0) {
      const fallbackBody = { ...createBody };
      delete fallbackBody.temporaryAttachmentIds;

      const fallbackAttempt = await createAttempt(fallbackBody);
      if (fallbackAttempt.ok) {
        finalAttempt = fallbackAttempt;
        createdWithoutAttachmentPayload = true;
        attachmentWarning =
          "Request created, but the selected request type did not accept attachments in this submission.";
      }
    }

    if (!finalAttempt.ok) {
      return { error: formatCreateError(finalAttempt) };
    }

    const createdRequest = finalAttempt.parsedBody || {};
    const createdIssueIdOrKey = createdRequest?.issueKey || createdRequest?.issueId || "";

    // Best-effort fallback: if create succeeded only without attachment payload,
    // try adding the same temporary attachments in a second request call.
    if (
      createdWithoutAttachmentPayload &&
      attachmentIdsForPayload.length > 0 &&
      createdIssueIdOrKey
    ) {
      try {
        const attachResponse = await api
          .asUser()
          .requestJira(route`/rest/servicedeskapi/request/${createdIssueIdOrKey}/attachment`, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              temporaryAttachmentIds: attachmentIdsForPayload,
              public: true,
            }),
          });

        if (attachResponse.ok) {
          attachmentWarning = "";
        } else {
          const attachRawText = await attachResponse.text();
          let attachDetails = attachRawText;

          try {
            const parsedAttachBody = attachRawText ? JSON.parse(attachRawText) : null;
            const attachErrors = Array.isArray(parsedAttachBody?.errorMessages)
              ? parsedAttachBody.errorMessages.filter(Boolean)
              : [];
            const attachFieldErrors =
              parsedAttachBody?.errors && typeof parsedAttachBody.errors === "object"
                ? Object.entries(parsedAttachBody.errors)
                    .map(([fieldId, message]) => `${fieldId}: ${message}`)
                    .filter(Boolean)
                : [];
            const detailedAttachError = [...attachErrors, ...attachFieldErrors].join("; ");
            if (detailedAttachError) {
              attachDetails = detailedAttachError;
            }
          } catch {
            // Keep raw attach error text if response isn't JSON.
          }

          attachmentWarning =
            "Request created, but attachments could not be added after creation " +
            `(${attachResponse.status} — ${attachDetails || "Unknown attachment error"}).`;
        }
      } catch (attachErr) {
        attachmentWarning =
          "Request created, but attachments could not be added after creation " +
          `(${attachErr.message || String(attachErr)}).`;
      }
    }

    return {
      success: true,
      issueKey: createdRequest?.issueKey || "",
      issueId: createdRequest?.issueId || "",
      requestLink: createdRequest?._links?.web || createdRequest?._links?.self || "",
      warning: attachmentWarning,
    };
  } catch (err) {
    return { error: `Failed to create request: ${err.message || String(err)}` };
  }
});

// ─── LLM / AI Model Settings ────────────────────────────────────────

resolver.define("getLLMSettings", async () => {
  return getLlmSettingsForAdmin();
});

resolver.define("saveLLMSettings", async ({ payload }) => {
  const { provider, model, apiKey } = payload || {};
  return saveLlmSettingsSecurely({ provider, model, apiKey });
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

  // Retrieve LLM settings and include them in the backend request.
  const llmSettings = await getLlmRuntimeSettings();
  const chatPayload = {
    ...payload,
    llm:
      llmSettings?.provider && llmSettings?.model && llmSettings?.apiKey
        ? {
            provider: llmSettings.provider,
            model: llmSettings.model,
            apiKey: llmSettings.apiKey,
          }
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
    const response = await api.asUser().requestJira(
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

/**
 * Deterministic issue key extraction keeps the assistant useful even when
 * an external AI provider is unavailable or temporarily misconfigured.
 */
const ISSUE_KEY_REGEX = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

/**
 * Greeting-only messages ("hi", "hello", etc.) should always return a
 * friendly help response instead of attempting AI extraction.
 */
const GREETING_ONLY_REGEX = /^(hi|hello|hey|yo|hola|good\s+(morning|afternoon|evening))(?:[\s!.,?])*$/i;

function extractIssueKeysFromMessage(message) {
  const normalizedMessage = (message || "").toUpperCase();
  const matches = normalizedMessage.match(ISSUE_KEY_REGEX) || [];
  return [...new Set(matches)];
}

function inferIntentFromMessage(message) {
  const lowerMessage = (message || "").toLowerCase();
  const asksAssignee = /\b(assignee|assigned|owner|working on)\b/.test(lowerMessage);
  const asksReporter = /\b(reporter|reported|raised|created by|opened by)\b/.test(lowerMessage);

  if (asksAssignee && asksReporter) {
    return "all";
  }
  if (asksAssignee) {
    return "assignee";
  }
  if (asksReporter) {
    return "reporter";
  }

  return "status";
}

function buildNoIssueKeyReply(message) {
  if (GREETING_ONLY_REGEX.test((message || "").trim())) {
    return `I'm your Jira Assistant! I can help you check the status, assignee, and reporter of Jira issues.\n\nTry asking me something like:\n• "What is the status of TJ-1?"\n• "Who is assigned to PROJ-42?"\n• "Tell me about ABC-10"`;
  }

  return "Please include a Jira issue key (for example TJ-1).\n\nI can then tell you the status, assignee, and reporter for that issue.";
}

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

  const rateLimitState = await checkPortalChatRateLimit(context);
  if (!rateLimitState.allowed) {
    return {
      reply:
        `You're sending messages too quickly. ` +
        `Please wait about ${rateLimitState.retryAfterSeconds} seconds and try again.`,
    };
  }

  // Retrieve LLM settings once. These are optional for deterministic mode;
  // if they are missing or invalid, we still return a useful fallback reply.
  const llmSettings = await getLlmRuntimeSettings();

  try {
    // Step 1: deterministic parsing avoids hard failures for simple greetings
    // and issue-key lookups when AI providers return transient 4xx errors.
    const issueKeys = extractIssueKeysFromMessage(message);
    const intent = inferIntentFromMessage(message);

    // No issue key present in the message.
    if (!issueKeys.length) {
      return { reply: buildNoIssueKeyReply(message) };
    }

    // Step 2: Fetch issue details for each issue key concurrently.
    const issueResults = await Promise.all(
      issueKeys.map(async (key) => {
        let response;
        try {
          // Use user-scoped Jira calls so portal customers only get issues they
          // are actually allowed to read in Jira Service Management.
          response = await api.asUser().requestJira(
            route`/rest/api/3/issue/${key}?fields=project,status,assignee,reporter,summary`,
            { headers: { Accept: "application/json" } }
          );
        } catch {
          return { issueKey: key, error: "not accessible" };
        }

        if (!response.ok) {
          return {
            issueKey: key,
            error:
              response.status === 404
                ? "not found"
                : response.status === 403
                ? "not accessible"
                : "fetch error",
          };
        }

        const data = await response.json();
        const fields = data.fields || {};

        // Extra safety guard: even if a key is valid, only answer for the same
        // portal project that the customer is currently browsing.
        const issueProjectId = normalizeProjectId(fields.project?.id);
        if (resolvedProjectId && (!issueProjectId || issueProjectId !== resolvedProjectId)) {
          return { issueKey: key, error: "not in this portal project" };
        }

        return {
          issueKey: data.key,
          summary: fields.summary || "",
          status: fields.status?.name || "Unknown",
          statusCategory: fields.status?.statusCategory?.name || "",
          assignee: fields.assignee?.displayName || "Unassigned",
          reporter: fields.reporter?.displayName || "Unknown",
        };
      })
    );

    // Start from a deterministic structured reply, then optionally enhance
    // with LLM phrasing when provider configuration is valid.
    let naturalReply = formatFallbackReply(issueResults, intent);

    const canUseLlmForReply = Boolean(
      llmSettings?.provider && llmSettings?.model && llmSettings?.apiKey
    );

    if (canUseLlmForReply) {
      // Keep user content isolated in a dedicated message payload to reduce
      // prompt-injection risk from direct instruction concatenation.
      const llmSystemPrompt =
        "You are Jira Assistant, a friendly and concise chatbot on a Jira Service Management customer portal. " +
        "Use only the provided issue data. If issue data contains errors, explain them politely. " +
        "Do not invent issue fields. Keep replies concise and conversational without markdown headers.";

      const llmUserMessage = JSON.stringify({
        userMessage: message,
        intent,
        issueResults,
      });

      const llmResult = await callLlmText({
        llmSettings,
        systemPrompt: llmSystemPrompt,
        userMessage: llmUserMessage,
        maxTokens: 500,
      });

      if (llmResult.text) {
        naturalReply = llmResult.text;
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
