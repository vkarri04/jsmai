import Resolver from "@forge/resolver";
import { storage } from "@forge/api";
import api from "@forge/api";

const resolver = new Resolver();

// ─── General Settings ────────────────────────────────────────────────

resolver.define("saveSettings", async ({ payload }) => {
  await storage.set("agentSettings", payload);
  return { success: true };
});

resolver.define("getSettings", async () => {
  const settings = await storage.get("agentSettings");
  return settings || { enableChatbot: false, fastApiUrl: "" };
});

// ─── Project-level Chat Settings ─────────────────────────────────────

resolver.define("getProjects", async () => {
  const response = await api.asApp().requestJira(
    "/rest/api/3/project/search?typeKey=service_desk&maxResults=100",
    { headers: { Accept: "application/json" } }
  );

  if (!response.ok) {
    const text = await response.text();
    return { error: `Failed to fetch projects: ${response.status} ${text}` };
  }

  const data = await response.json();
  return {
    projects: data.values.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      avatarUrl: p.avatarUrls?.["48x48"] || p.avatarUrls?.["32x32"] || "",
    })),
  };
});

resolver.define("getProjectChatSettings", async () => {
  const settings = await storage.get("projectChatSettings");
  return settings || {};
});

resolver.define("saveProjectChatSettings", async ({ payload }) => {
  await storage.set("projectChatSettings", payload);
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

  const response = await fetch(`${settings.fastApiUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  return data;
});

export const handler = resolver.getDefinitions();