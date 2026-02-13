import React, { useEffect, useState } from "react";
import { view } from "@forge/bridge";

function App() {
  const [issueKey, setIssueKey] = useState(null);

  useEffect(() => {
    view.getContext().then((context) => {
      setIssueKey(context.extension.issue.key);
    });
  }, []);

  return (
    <div style={{ padding: "16px" }}>
      <h3>AI Agent</h3>
      <p>Current Issue: {issueKey}</p>
      <button onClick={() => alert("AI analysis coming soon!")}>
        Analyze Issue
      </button>
    </div>
  );
}

export default App;