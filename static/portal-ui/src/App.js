import React, { useState, useRef, useEffect } from 'react';
import { invoke } from '@forge/bridge';

const styles = {
  container: {
    maxWidth: 600,
    margin: '0 auto',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 480,
  },
  header: {
    padding: '16px 20px',
    background: '#0052CC',
    color: '#FFFFFF',
    borderRadius: '8px 8px 0 0',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    flexShrink: 0,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: 600,
  },
  headerSubtitle: {
    fontSize: 12,
    opacity: 0.85,
    marginTop: 2,
  },
  chatArea: {
    flex: 1,
    overflowY: 'auto',
    padding: 16,
    background: '#F4F5F7',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  messageBubble: (isUser) => ({
    maxWidth: '80%',
    padding: '10px 14px',
    borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
    background: isUser ? '#0052CC' : '#FFFFFF',
    color: isUser ? '#FFFFFF' : '#172B4D',
    alignSelf: isUser ? 'flex-end' : 'flex-start',
    fontSize: 14,
    lineHeight: '1.5',
    boxShadow: isUser ? 'none' : '0 1px 3px rgba(0,0,0,0.08)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  }),
  botLabel: {
    fontSize: 11,
    color: '#6B778C',
    marginBottom: 2,
    fontWeight: 500,
  },
  typingIndicator: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '10px 14px',
    background: '#FFFFFF',
    borderRadius: '16px 16px 16px 4px',
    alignSelf: 'flex-start',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  typingDot: (delay) => ({
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#B3BAC5',
    animation: `typing 1.2s infinite ${delay}s`,
  }),
  inputArea: {
    display: 'flex',
    padding: 12,
    gap: 8,
    background: '#FFFFFF',
    borderTop: '1px solid #DFE1E6',
    borderRadius: '0 0 8px 8px',
  },
  input: {
    flex: 1,
    padding: '10px 14px',
    fontSize: 14,
    border: '1px solid #DFE1E6',
    borderRadius: 20,
    outline: 'none',
    color: '#172B4D',
    backgroundColor: '#FAFBFC',
    boxSizing: 'border-box',
  },
  sendButton: (disabled) => ({
    padding: '8px 16px',
    fontSize: 14,
    fontWeight: 500,
    color: '#FFFFFF',
    backgroundColor: disabled ? '#B3D4FF' : '#0052CC',
    border: 'none',
    borderRadius: 20,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background-color 0.15s',
    flexShrink: 0,
  }),
  wrapper: {
    border: '1px solid #DFE1E6',
    borderRadius: 8,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    minHeight: 480,
    boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
  },
};

// CSS animation for typing dots
const typingKeyframes = `
@keyframes typing {
  0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
  30% { opacity: 1; transform: scale(1); }
}
`;

const WELCOME_MESSAGE = {
  role: 'bot',
  content:
    "Hi! I'm your Jira Assistant. I can help you check the status, assignee, and reporter of any Jira issue.\n\nTry asking me something like:\n\u2022 \"What is the status of TJ-1?\"\n\u2022 \"Who is assigned to PROJ-42?\"\n\u2022 \"What's going on with ABC-10?\"\n\u2022 \"Tell me about TJ-5\"",
};

function App() {
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const userMessage = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const result = await invoke('portalChat', { message: text });

      const botMessage = {
        role: 'bot',
        content: result.reply || result.error || 'Sorry, I could not process your request.',
      };
      setMessages((prev) => [...prev, botMessage]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'bot', content: 'Something went wrong. Please try again.' },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div style={styles.container}>
      <style>{typingKeyframes}</style>
      <div style={styles.wrapper}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerIcon}>JA</div>
          <div>
            <div style={styles.headerTitle}>Jira Assistant</div>
            <div style={styles.headerSubtitle}>Ask me about your Jira issues</div>
          </div>
        </div>

        {/* Chat Messages */}
        <div style={styles.chatArea}>
          {messages.map((msg, i) => (
            <div key={i}>
              {msg.role === 'bot' && <div style={styles.botLabel}>Jira Assistant</div>}
              <div style={styles.messageBubble(msg.role === 'user')}>{msg.content}</div>
            </div>
          ))}

          {loading && (
            <div>
              <div style={styles.botLabel}>Jira Assistant</div>
              <div style={styles.typingIndicator}>
                <div style={styles.typingDot(0)} />
                <div style={styles.typingDot(0.2)} />
                <div style={styles.typingDot(0.4)} />
              </div>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Input Area */}
        <div style={styles.inputArea}>
          <input
            style={styles.input}
            type="text"
            placeholder="Ask about an issue... (e.g., What's going on with TJ-1?)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
          />
          <button
            type="button"
            style={styles.sendButton(loading || !input.trim())}
            disabled={loading || !input.trim()}
            onClick={handleSend}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
