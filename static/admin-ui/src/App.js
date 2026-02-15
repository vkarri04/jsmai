import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@forge/bridge';

const styles = {
  container: {
    maxWidth: 720,
    margin: '0 auto',
    padding: 24,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
  },
  heading: {
    fontSize: 24,
    fontWeight: 600,
    marginBottom: 4,
    color: '#172B4D',
  },
  subtitle: {
    fontSize: 14,
    color: '#6B778C',
    marginBottom: 24,
  },
  card: {
    background: '#FFFFFF',
    borderRadius: 8,
    border: '1px solid #DFE1E6',
    overflow: 'hidden',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    borderBottom: '1px solid #DFE1E6',
    background: '#FAFBFC',
  },
  cardHeaderTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: '#172B4D',
  },
  cardHeaderRight: {
    fontSize: 12,
    color: '#6B778C',
  },
  projectRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '12px 20px',
    borderBottom: '1px solid #EBECF0',
    transition: 'background 0.15s',
  },
  projectRowHover: {
    background: '#F4F5F7',
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 4,
    marginRight: 12,
    flexShrink: 0,
  },
  projectInfo: {
    flex: 1,
    minWidth: 0,
  },
  projectName: {
    fontSize: 14,
    fontWeight: 500,
    color: '#172B4D',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  projectKey: {
    fontSize: 12,
    color: '#6B778C',
    marginTop: 2,
  },
  toggleContainer: {
    flexShrink: 0,
    marginLeft: 16,
  },
  // Custom toggle styles (CSS-only toggle switch)
  toggleLabel: {
    position: 'relative',
    display: 'inline-block',
    width: 40,
    height: 20,
    cursor: 'pointer',
  },
  toggleInput: {
    opacity: 0,
    width: 0,
    height: 0,
    position: 'absolute',
  },
  toggleSlider: (checked) => ({
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: checked ? '#36B37E' : '#C1C7D0',
    borderRadius: 20,
    transition: 'background-color 0.2s',
  }),
  toggleKnob: (checked) => ({
    position: 'absolute',
    height: 16,
    width: 16,
    left: checked ? 21 : 3,
    bottom: 2,
    backgroundColor: '#FFFFFF',
    borderRadius: '50%',
    transition: 'left 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
  }),
  banner: (type) => ({
    padding: '12px 16px',
    borderRadius: 4,
    marginBottom: 16,
    fontSize: 14,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: type === 'success' ? '#E3FCEF' : type === 'error' ? '#FFEBE6' : '#DEEBFF',
    color: type === 'success' ? '#006644' : type === 'error' ? '#BF2600' : '#0747A6',
  }),
  loading: {
    textAlign: 'center',
    padding: 48,
    color: '#6B778C',
    fontSize: 14,
  },
  emptyState: {
    textAlign: 'center',
    padding: 48,
    color: '#6B778C',
    fontSize: 14,
  },
  enabledCount: {
    fontSize: 12,
    color: '#36B37E',
    fontWeight: 500,
  },
  // ─── AI Model Settings styles ──────────────────────────────
  sectionSpacing: {
    marginTop: 32,
  },
  formGroup: {
    padding: '16px 20px',
    borderBottom: '1px solid #EBECF0',
  },
  formGroupLast: {
    padding: '16px 20px',
  },
  label: {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: '#6B778C',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  select: {
    width: '100%',
    padding: '8px 12px',
    fontSize: 14,
    border: '1px solid #DFE1E6',
    borderRadius: 4,
    backgroundColor: '#FAFBFC',
    color: '#172B4D',
    outline: 'none',
    boxSizing: 'border-box',
  },
  input: {
    width: '100%',
    padding: '8px 12px',
    fontSize: 14,
    border: '1px solid #DFE1E6',
    borderRadius: 4,
    backgroundColor: '#FAFBFC',
    color: '#172B4D',
    outline: 'none',
    boxSizing: 'border-box',
  },
  saveButton: (disabled) => ({
    padding: '8px 20px',
    fontSize: 14,
    fontWeight: 500,
    color: '#FFFFFF',
    backgroundColor: disabled ? '#B3D4FF' : '#0052CC',
    border: 'none',
    borderRadius: 4,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background-color 0.15s',
  }),
  buttonRow: {
    padding: '16px 20px',
    display: 'flex',
    justifyContent: 'flex-end',
    borderTop: '1px solid #DFE1E6',
    background: '#FAFBFC',
  },
  apiKeyWrapper: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
  },
  apiKeyInput: {
    width: '100%',
    padding: '8px 40px 8px 12px',
    fontSize: 14,
    border: '1px solid #DFE1E6',
    borderRadius: 4,
    backgroundColor: '#FAFBFC',
    color: '#172B4D',
    outline: 'none',
    boxSizing: 'border-box',
  },
  showHideButton: {
    position: 'absolute',
    right: 8,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 12,
    color: '#6B778C',
    padding: '4px',
  },
};

function Toggle({ checked, onChange, projectName }) {
  return (
    <label style={styles.toggleLabel} title={checked ? `Disable chat for ${projectName}` : `Enable chat for ${projectName}`}>
      <input
        type="checkbox"
        style={styles.toggleInput}
        checked={checked}
        onChange={onChange}
        aria-label={`Toggle chat agent for ${projectName}`}
      />
      <span style={styles.toggleSlider(checked)}>
        <span style={styles.toggleKnob(checked)} />
      </span>
    </label>
  );
}

const MODEL_OPTIONS = {
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo' },
  ],
  claude: [
    { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
    { value: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
};

function App() {
  const [projects, setProjects] = useState([]);
  const [projectSettings, setProjectSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notification, setNotification] = useState(null);
  const [hoveredRow, setHoveredRow] = useState(null);

  // LLM settings state
  const [llmProvider, setLlmProvider] = useState('openai');
  const [llmModel, setLlmModel] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [hasStoredApiKey, setHasStoredApiKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [savingLLM, setSavingLLM] = useState(false);

  const showNotification = useCallback((message, type = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  }, []);

  useEffect(() => {
    async function loadData() {
      try {
        const [projectsResult, settingsResult, llmResult] = await Promise.all([
          invoke('getProjects'),
          invoke('getProjectChatSettings'),
          invoke('getLLMSettings'),
        ]);

        if (projectsResult.error) {
          setError(projectsResult.error);
          return;
        }

        setProjects(projectsResult.projects || []);
        setProjectSettings(settingsResult || {});

        if (llmResult) {
          setLlmProvider(llmResult.provider || 'openai');
          setLlmModel(llmResult.model || '');
          setLlmApiKey(llmResult.apiKeyMasked || llmResult.apiKey || '');
          setHasStoredApiKey(Boolean(llmResult.hasApiKey));
        }
      } catch (err) {
        setError(`Failed to load project data: ${err.message || 'Unknown error'}. Please try again.`);
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, []);

  const handleToggle = async (projectId) => {
    const updated = {
      ...projectSettings,
      [projectId]: !projectSettings[projectId],
    };

    setProjectSettings(updated);
    setSaving(true);

    try {
      const result = await invoke('saveProjectChatSettings', updated);
      if (result.success) {
        const enabled = updated[projectId];
        const project = projects.find((p) => p.id === projectId);
        showNotification(
          `Chat agent ${enabled ? 'enabled' : 'disabled'} for ${project?.name || projectId}`
        );
      }
    } catch (err) {
      // Revert on failure
      setProjectSettings((prev) => ({
        ...prev,
        [projectId]: !updated[projectId],
      }));
      showNotification('Failed to save setting. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleProviderChange = (e) => {
    const newProvider = e.target.value;
    setLlmProvider(newProvider);
    // Reset model when switching providers
    setLlmModel('');
  };

  const handleSaveLLM = async () => {
    if (!llmModel) {
      showNotification('Please select a model.', 'error');
      return;
    }
    if (!llmApiKey.trim() && !hasStoredApiKey) {
      showNotification('Please enter an API key.', 'error');
      return;
    }

    setSavingLLM(true);
    try {
      const result = await invoke('saveLLMSettings', {
        provider: llmProvider,
        model: llmModel,
        apiKey: llmApiKey.trim(),
      });

      if (result.error) {
        showNotification(result.error, 'error');
      } else {
        const refreshedSettings = await invoke('getLLMSettings');
        setLlmProvider(refreshedSettings?.provider || llmProvider);
        setLlmModel(refreshedSettings?.model || llmModel);
        setLlmApiKey(refreshedSettings?.apiKeyMasked || refreshedSettings?.apiKey || '');
        setHasStoredApiKey(Boolean(refreshedSettings?.hasApiKey));
        showNotification(`AI model settings saved — using ${llmProvider === 'openai' ? 'OpenAI' : 'Claude'}`);
      }
    } catch (err) {
      showNotification('Failed to save AI model settings. Please try again.', 'error');
    } finally {
      setSavingLLM(false);
    }
  };

  const enabledCount = Object.values(projectSettings).filter(Boolean).length;

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>Loading projects...</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.heading}>Chat Agent Settings</h1>
      <p style={styles.subtitle}>
        Enable or disable the Chat Agent on the Customer Portal for each service project.
      </p>

      {notification && (
        <div style={styles.banner(notification.type)}>
          {notification.type === 'success' ? '\u2713' : '\u2717'} {notification.message}
        </div>
      )}

      {error && (
        <div style={styles.banner('error')}>
          {error}
        </div>
      )}

      {!error && (
        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardHeaderTitle}>
              Service Projects ({projects.length})
            </span>
            <span style={styles.enabledCount}>
              {enabledCount} of {projects.length} enabled
            </span>
          </div>

          {projects.length === 0 ? (
            <div style={styles.emptyState}>
              No service management projects found.
            </div>
          ) : (
            projects.map((project, index) => (
              <div
                key={project.id}
                style={{
                  ...styles.projectRow,
                  ...(hoveredRow === project.id ? styles.projectRowHover : {}),
                  ...(index === projects.length - 1
                    ? { borderBottom: 'none' }
                    : {}),
                }}
                onMouseEnter={() => setHoveredRow(project.id)}
                onMouseLeave={() => setHoveredRow(null)}
              >
                {project.avatarUrl && (
                  <img
                    src={project.avatarUrl}
                    alt=""
                    style={styles.avatar}
                  />
                )}
                <div style={styles.projectInfo}>
                  <div style={styles.projectName}>{project.name}</div>
                  <div style={styles.projectKey}>{project.key}</div>
                </div>
                <div style={styles.toggleContainer}>
                  <Toggle
                    checked={!!projectSettings[project.id]}
                    onChange={() => handleToggle(project.id)}
                    projectName={project.name}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ─── AI Model Configuration ──────────────────────────────── */}
      <div style={styles.sectionSpacing}>
        <h2 style={{ ...styles.heading, fontSize: 20 }}>AI Model Configuration</h2>
        <p style={styles.subtitle}>
          Choose which AI provider and model the Chat Agent uses to respond to customers.
        </p>

        <div style={styles.card}>
          <div style={styles.cardHeader}>
            <span style={styles.cardHeaderTitle}>Provider & Model</span>
            <span style={{ fontSize: 12, color: '#6B778C' }}>
              {llmProvider === 'openai' ? 'OpenAI' : 'Anthropic Claude'}
              {llmModel ? ` — ${llmModel}` : ''}
            </span>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>AI Provider</label>
            <select
              style={styles.select}
              value={llmProvider}
              onChange={handleProviderChange}
            >
              <option value="openai">OpenAI</option>
              <option value="claude">Anthropic Claude</option>
            </select>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Model</label>
            <select
              style={styles.select}
              value={llmModel}
              onChange={(e) => setLlmModel(e.target.value)}
            >
              <option value="">Select a model...</option>
              {MODEL_OPTIONS[llmProvider].map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div style={styles.formGroupLast}>
            <label style={styles.label}>API Key</label>
            <div style={styles.apiKeyWrapper}>
              <input
                style={styles.apiKeyInput}
                type={showApiKey ? 'text' : 'password'}
                value={llmApiKey}
                onChange={(e) => setLlmApiKey(e.target.value)}
                placeholder={llmProvider === 'openai' ? 'sk-...' : 'sk-ant-...'}
              />
              <button
                type="button"
                style={styles.showHideButton}
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div style={styles.buttonRow}>
            <button
              type="button"
              style={styles.saveButton(savingLLM || !llmModel || (!hasStoredApiKey && !llmApiKey.trim()))}
              disabled={savingLLM || !llmModel || (!hasStoredApiKey && !llmApiKey.trim())}
              onClick={handleSaveLLM}
            >
              {savingLLM ? 'Saving...' : 'Save AI Settings'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
