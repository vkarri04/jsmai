import React, { useState, useRef, useEffect } from 'react';
import { invoke, view } from '@forge/bridge';

/* ── keyframe animations injected once ── */
const keyframes = `
@keyframes typing {
  0%, 60%, 100% { opacity: 0.3; transform: scale(0.8); }
  30% { opacity: 1; transform: scale(1); }
}
@keyframes tooltipFadeIn {
  0%   { opacity: 0; transform: translateX(8px); }
  100% { opacity: 1; transform: translateX(0); }
}
@keyframes pulse {
  0%   { box-shadow: 0 4px 12px rgba(0,82,204,0.35); }
  50%  { box-shadow: 0 4px 24px rgba(0,82,204,0.55); }
  100% { box-shadow: 0 4px 12px rgba(0,82,204,0.35); }
}
@keyframes slideUp {
  0%   { opacity: 0; transform: translateY(16px) scale(0.96); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
`;

/* ── Chat bubble SVG icon ── */
const ChatIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
    <path
      d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2Z"
      fill="#FFFFFF"
    />
    <circle cx="8" cy="10" r="1.2" fill="#0052CC" />
    <circle cx="12" cy="10" r="1.2" fill="#0052CC" />
    <circle cx="16" cy="10" r="1.2" fill="#0052CC" />
  </svg>
);

/* ── Close (X) icon ── */
const CloseIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
    <path d="M18 6L6 18M6 6L18 18" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

const WELCOME_MESSAGE = {
  role: 'bot',
  content:
    "Hi! I'm your Jira Assistant. I can help you check the status, assignee, and reporter of any Jira issue.\n\nTry asking me something like:\n\u2022 \"What is the status of TJ-1?\"\n\u2022 \"Who is assigned to PROJ-42?\"\n\u2022 \"Tell me about TJ-5\"",
};

/**
 * Portal context shape differs slightly across JSM pages. This helper extracts
 * whichever project references are present so backend checks stay consistent.
 */
function extractPortalProjectContext(context) {
  const extension = context?.extension || {};

  let portalIdCandidate =
    extension?.portal?.id ??
    extension?.portalId ??
    extension?.request?.portalId ??
    null;

  const projectIdCandidate =
    extension?.project?.id ??
    extension?.portal?.projectId ??
    extension?.request?.projectId ??
    null;

  const projectKeyCandidate =
    extension?.project?.key ??
    extension?.portal?.projectKey ??
    extension?.request?.projectKey ??
    null;

  // Fallback for pages where only parent URL exposes portal id.
  if (!portalIdCandidate && document.referrer) {
    try {
      const parentUrl = new URL(document.referrer);
      const portalMatch = parentUrl.pathname.match(/\/servicedesk\/customer\/portal\/(\d+)/);
      if (portalMatch?.[1]) {
        portalIdCandidate = portalMatch[1];
      }
    } catch {
      // Ignore malformed referrer values.
    }
  }

  return {
    projectId: projectIdCandidate ? String(projectIdCandidate) : null,
    projectKey: projectKeyCandidate ? String(projectKeyCandidate) : null,
    portalId: portalIdCandidate ? String(portalIdCandidate) : null,
  };
}

function App() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(true);
  const [portalProject, setPortalProject] = useState({ projectId: null, projectKey: null, portalId: null });
  const [chatEnabledForProject, setChatEnabledForProject] = useState(false);
  const [availabilityReason, setAvailabilityReason] = useState(null);
  const [checkingAvailability, setCheckingAvailability] = useState(true);
  const chatEndRef = useRef(null);

  /* load current portal context and decide if widget should render */
  useEffect(() => {
    let isCancelled = false;

    async function loadPortalAvailability() {
      try {
        const context = await view.getContext();
        const extractedProject = extractPortalProjectContext(context);

        const availability = await invoke('getPortalChatAvailability', extractedProject);
        const resolvedProjectId = availability?.projectId || extractedProject.projectId || null;

        if (!isCancelled) {
          setPortalProject({
            projectId: resolvedProjectId,
            projectKey: extractedProject.projectKey,
            portalId: extractedProject.portalId,
          });
          setChatEnabledForProject(Boolean(availability?.enabled));
          setAvailabilityReason(availability?.reason || null);
        }
      } catch {
        if (!isCancelled) {
          setChatEnabledForProject(false);
          setAvailabilityReason('availability_check_failed');
        }
      } finally {
        if (!isCancelled) {
          setCheckingAvailability(false);
        }
      }
    }

    loadPortalAvailability();
    return () => {
      isCancelled = true;
    };
  }, []);

  /* auto-scroll on new messages */
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading]);

  /* hide tooltip after 8 seconds */
  useEffect(() => {
    const timer = setTimeout(() => setTooltipVisible(false), 8000);
    return () => clearTimeout(timer);
  }, []);

  /* show tooltip again when chat is closed */
  useEffect(() => {
    if (!open) {
      const timer = setTimeout(() => setTooltipVisible(true), 1000);
      return () => clearTimeout(timer);
    } else {
      setTooltipVisible(false);
    }
  }, [open]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setInput('');
    setLoading(true);

    try {
      const result = await invoke('portalChat', {
        message: text,
        projectId: portalProject.projectId,
        projectKey: portalProject.projectKey,
        portalId: portalProject.portalId,
      });
      setMessages((prev) => [
        ...prev,
        {
          role: 'bot',
          content: result.reply || result.error || 'Sorry, I could not process your request.',
        },
      ]);
    } catch {
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

  if (checkingAvailability) {
    return null;
  }

  // Hide only when explicitly disabled. Keep visible on global portal pages
  // where a specific project context is not available.
  const shouldHideWidget =
    !chatEnabledForProject &&
    availabilityReason !== 'missing_project_context';

  if (shouldHideWidget) {
    return null;
  }

  return (
    <div style={s.root}>
      <style>{keyframes}</style>

      {/* ─── Expanded chat window ─── */}
      {open && (
        <div style={s.chatWindow}>
          {/* header */}
          <div style={s.header}>
            <div style={s.headerIcon}>
              <ChatIcon />
            </div>
            <div style={{ flex: 1 }}>
              <div style={s.headerTitle}>Jira Assistant</div>
              <div style={s.headerSubtitle}>Ask me about your Jira issues</div>
            </div>
            <button
              type="button"
              style={s.closeBtn}
              onClick={() => setOpen(false)}
              aria-label="Close chat"
            >
              <CloseIcon />
            </button>
          </div>

          {/* messages */}
          <div style={s.chatArea}>
            {messages.map((msg, i) => (
              <div key={i}>
                {msg.role === 'bot' && <div style={s.botLabel}>Jira Assistant</div>}
                <div style={s.bubble(msg.role === 'user')}>{msg.content}</div>
              </div>
            ))}

            {loading && (
              <div>
                <div style={s.botLabel}>Jira Assistant</div>
                <div style={s.typingWrap}>
                  <div style={s.dot(0)} />
                  <div style={s.dot(0.2)} />
                  <div style={s.dot(0.4)} />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {/* input */}
          <div style={s.inputArea}>
            <input
              style={s.input}
              type="text"
              placeholder="Ask about an issue…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
            />
            <button
              type="button"
              style={s.sendBtn(loading || !input.trim())}
              disabled={loading || !input.trim()}
              onClick={handleSend}
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* ─── Floating action button + tooltip ─── */}
      <div style={s.fabRow}>
        {!open && tooltipVisible && (
          <div style={s.tooltip}>
            <span style={s.tooltipText}>How can I help?</span>
            <div style={s.tooltipArrow} />
          </div>
        )}
        <button
          type="button"
          style={s.fab(open)}
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? 'Close chat' : 'Open chat'}
        >
          {open ? <CloseIcon /> : <ChatIcon />}
        </button>
      </div>
    </div>
  );
}

/* ── Styles ── */
const s = {
  root: {
    width: '100%',
    maxWidth: 520,
    marginLeft: 'auto',
    padding: '8px 0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 12,
    boxSizing: 'border-box',
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
  },

  /* ── FAB row (tooltip + button) ── */
  fabRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  },
  fab: (isOpen) => ({
    width: 56,
    height: 56,
    borderRadius: '50%',
    border: 'none',
    background: isOpen
      ? '#344563'
      : 'linear-gradient(135deg, #0065FF 0%, #0052CC 100%)',
    color: '#FFFFFF',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    animation: isOpen ? 'none' : 'pulse 2.5s infinite',
    transition: 'background 0.25s, transform 0.2s',
    boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
    flexShrink: 0,
  }),

  /* ── Tooltip ── */
  tooltip: {
    position: 'relative',
    background: '#FFFFFF',
    borderRadius: 20,
    padding: '8px 16px',
    boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
    animation: 'tooltipFadeIn 0.4s ease-out',
    whiteSpace: 'nowrap',
  },
  tooltipText: {
    fontSize: 14,
    fontWeight: 600,
    color: '#0052CC',
  },
  tooltipArrow: {
    position: 'absolute',
    right: -6,
    top: '50%',
    marginTop: -6,
    width: 0,
    height: 0,
    borderTop: '6px solid transparent',
    borderBottom: '6px solid transparent',
    borderLeft: '6px solid #FFFFFF',
  },

  /* ── Chat window ── */
  chatWindow: {
    width: '100%',
    maxWidth: 480,
    height: 620,
    minHeight: 620,
    borderRadius: 16,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    background: '#FFFFFF',
    boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
    animation: 'slideUp 0.3s ease-out',
  },

  /* ── Header ── */
  header: {
    padding: '14px 16px',
    background: 'linear-gradient(135deg, #0065FF 0%, #0052CC 100%)',
    color: '#FFFFFF',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  headerIcon: {
    width: 38,
    height: 38,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.18)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  headerTitle: { fontSize: 16, fontWeight: 600 },
  headerSubtitle: { fontSize: 12, opacity: 0.85, marginTop: 2 },
  closeBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    opacity: 0.8,
  },

  /* ── Messages ── */
  chatArea: {
    flex: 1,
    overflowY: 'auto',
    padding: 14,
    minHeight: 380,
    background: '#F4F5F7',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  bubble: (isUser) => ({
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

  /* ── Typing indicator ── */
  typingWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '10px 14px',
    background: '#FFFFFF',
    borderRadius: '16px 16px 16px 4px',
    alignSelf: 'flex-start',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
  dot: (delay) => ({
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#B3BAC5',
    animation: `typing 1.2s infinite ${delay}s`,
  }),

  /* ── Input area ── */
  inputArea: {
    display: 'flex',
    padding: 10,
    gap: 8,
    background: '#FFFFFF',
    borderTop: '1px solid #DFE1E6',
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
  sendBtn: (disabled) => ({
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
};

export default App;
