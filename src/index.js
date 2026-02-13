import Resolver from "@forge/resolver";
import { storage } from "@forge/api";

const resolver = new Resolver();

resolver.define("saveSettings", async ({ payload }) => {
  await storage.set("agentSettings", payload);
  return { success: true };
});

resolver.define("getSettings", async () => {
  const settings = await storage.get("agentSettings");
  return settings || { enableChatbot: false, fastApiUrl: "" };
});

resolver.define("chat", async ({ payload }) => {
  const settings = await storage.get("agentSettings");

  if (!settings?.enableChatbot) {
    return { error: "Chatbot is disabled by admin." };
  }

  if (!settings?.fastApiUrl) {
    return { error: "FastAPI URL not configured." };
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