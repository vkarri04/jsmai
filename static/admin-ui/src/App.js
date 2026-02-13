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

function App() {
  const [projects, setProjects] = useState([]);
  const [projectSettings, setProjectSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notification, setNotification] = useState(null);
  const [hoveredRow, setHoveredRow] = useState(null);

  const showNotification = useCallback((message, type = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  }, []);

  useEffect(() => {
    async function loadData() {
      try {
        const [projectsResult, settingsResult] = await Promise.all([
          invoke('getProjects'),
          invoke('getProjectChatSettings'),
        ]);

        if (projectsResult.error) {
          setError(projectsResult.error);
          return;
        }

        setProjects(projectsResult.projects || []);
        setProjectSettings(settingsResult || {});
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
            projects.map((project) => (
              <div
                key={project.id}
                style={{
                  ...styles.projectRow,
                  ...(hoveredRow === project.id ? styles.projectRowHover : {}),
                  ...(projects.indexOf(project) === projects.length - 1
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
    </div>
  );
}

export default App;
