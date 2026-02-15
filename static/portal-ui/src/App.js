import React, { useEffect, useRef, useState } from 'react';
import { invoke, requestJira, view } from '@forge/bridge';

/*
 * Animations are injected once from JS so we keep this custom UI self-contained
 * (no extra CSS files required for Forge static resource packaging).
 */
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

/*
 * The portal iframe host sometimes applies restrictive sizing. These overrides
 * keep the chat container eligible for dynamic height growth.
 */
const globalLayoutFix = `
html, body, #root {
  height: auto !important;
  min-height: 0 !important;
  width: 100%;
  overflow: visible !important;
}
body {
  margin: 0;
}
`;

const CREATE_REQUEST_INTENT_REGEX =
  /\b(create|raise|submit|open)\b.*\b(request|ticket|issue)\b|\bnew request\b/i;
const CANCEL_FLOW_REGEX = /^(cancel|stop|exit|reset)$/i;
const SKIP_STEP_REGEX = /^(skip|no|none|not now|done|continue|next)$/i;
const CONFIRM_REGEX = /^(yes|y|create|submit|confirm|go ahead)$/i;
const ATTACH_HELP_REGEX = /\b(attach|upload|file|document)\b/i;

const createMessage = (role, content, options) => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  role,
  content,
  options: Array.isArray(options) ? options : undefined,
});

const WELCOME_MESSAGE = createMessage(
  'bot',
  "Hi! I'm your Jira Assistant. I can help with issue lookups and request creation.\n\n" +
    'Examples:\n' +
    '- "What is the status of TJ-1?"\n' +
    '- "Who is assigned to PROJ-42?"\n' +
    '- "I want to create a request"'
);

const INITIAL_CREATE_FLOW = {
  active: false,
  stage: 'idle',
  projects: [],
  requestTypes: [],
  selectedProject: null,
  selectedRequestType: null,
  allowsAttachments: false,
  fields: [],
  currentFieldIndex: 0,
  answers: {},
  temporaryAttachmentIds: [],
  attachmentNames: [],
};

/* Chat bubble SVG icon */
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

/* Close (X) icon */
const CloseIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
    <path d="M18 6L6 18M6 6L18 18" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

/* Paperclip icon for attachment upload action */
const AttachmentIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path
      d="M21.44 11.05L12.25 20.24C9.61 22.88 5.34 22.88 2.7 20.24C0.06 17.6 0.06 13.33 2.7 10.69L11.89 1.5C13.65 -0.26 16.51 -0.26 18.27 1.5C20.03 3.26 20.03 6.12 18.27 7.88L9.08 17.07C8.2 17.95 6.77 17.95 5.89 17.07C5.01 16.19 5.01 14.76 5.89 13.88L14.37 5.4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Portal context shape differs across JSM pages. This helper extracts whichever
 * project references are available so backend permission checks stay consistent.
 */
function extractPortalProjectContext(context) {
  const extension = context?.extension || {};

  let portalIdCandidate =
    extension?.portal?.id ?? extension?.portalId ?? extension?.request?.portalId ?? null;

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

  // Fallback for views where only the parent URL includes the portal id.
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

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function findItemByUserInput(items, userInput, tokenBuilder) {
  const normalizedInput = normalizeText(userInput);
  if (!normalizedInput || !Array.isArray(items) || items.length === 0) {
    return null;
  }

  const numericIndex = Number.parseInt(normalizedInput, 10);
  if (
    Number.isFinite(numericIndex) &&
    String(numericIndex) === normalizedInput &&
    numericIndex >= 1 &&
    numericIndex <= items.length
  ) {
    return items[numericIndex - 1];
  }

  return (
    items.find((item, index) => {
      const tokens = tokenBuilder(item, index)
        .map((token) => normalizeText(token))
        .filter(Boolean);

      return tokens.some(
        (token) => token === normalizedInput || token.includes(normalizedInput)
      );
    }) || null
  );
}

function buildProjectOptions(projects) {
  return projects.map((project, index) => ({
    label: `${index + 1}. ${project.projectName}`,
    value: project.serviceDeskId,
  }));
}

function buildRequestTypeOptions(requestTypes) {
  return requestTypes.map((requestType, index) => ({
    label: `${index + 1}. ${requestType.name}`,
    value: requestType.id,
  }));
}

function buildFieldOptions(field) {
  if (!Array.isArray(field?.validValues) || field.validValues.length === 0) {
    return [];
  }

  return field.validValues.slice(0, 12).map((option, index) => ({
    label: `${index + 1}. ${option.label}`,
    value: option.id || option.value || option.label,
  }));
}

function buildFieldPrompt(field, index, total) {
  const promptLines = [`Field ${index + 1} of ${total}: ${field.name}`];

  if (field.description) {
    promptLines.push(field.description);
  }

  if (field.inputType === 'select' || field.inputType === 'multi_select') {
    promptLines.push('Choose an option below, or type the option name/number.');
  } else if (field.inputType === 'date') {
    promptLines.push('Enter a date in YYYY-MM-DD format.');
  } else if (field.inputType === 'datetime') {
    promptLines.push('Enter a date/time (for example: 2026-02-13T14:30:00.000+0000).');
  } else if (field.inputType === 'number') {
    promptLines.push('Enter a numeric value.');
  } else {
    promptLines.push('Enter a value.');
  }

  return promptLines.join('\n');
}

function formatAnswerForSummary(answer) {
  if (answer === null || answer === undefined) {
    return '';
  }

  if (Array.isArray(answer)) {
    return answer.map((item) => formatAnswerForSummary(item)).join(', ');
  }

  if (typeof answer === 'object') {
    return answer.label || answer.value || answer.id || answer.accountId || JSON.stringify(answer);
  }

  return String(answer);
}

function extractTemporaryAttachment(payload) {
  const listCandidates = [];
  if (Array.isArray(payload?.temporaryAttachments)) {
    listCandidates.push(...payload.temporaryAttachments);
  }
  if (Array.isArray(payload?.values)) {
    listCandidates.push(...payload.values);
  }

  if (listCandidates.length > 0) {
    const first = listCandidates[0];
    return {
      id: first?.temporaryAttachmentId || first?.id,
      fileName: first?.fileName || first?.filename || '',
    };
  }

  if (payload?.temporaryAttachmentId || payload?.id) {
    return {
      id: payload.temporaryAttachmentId || payload.id,
      fileName: payload.fileName || payload.filename || '',
    };
  }

  return null;
}

function App() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(true);
  const [portalProject, setPortalProject] = useState({
    projectId: null,
    projectKey: null,
    portalId: null,
  });
  const [chatEnabledForProject, setChatEnabledForProject] = useState(false);
  const [availabilityReason, setAvailabilityReason] = useState(null);
  const [checkingAvailability, setCheckingAvailability] = useState(true);
  const [createFlow, setCreateFlow] = useState(INITIAL_CREATE_FLOW);

  const chatEndRef = useRef(null);
  const fileInputRef = useRef(null);

  const appendBotMessage = (content, options) => {
    setMessages((prev) => [...prev, createMessage('bot', content, options)]);
  };

  const appendUserMessage = (content) => {
    setMessages((prev) => [...prev, createMessage('user', content)]);
  };

  const resetCreateFlow = () => {
    setCreateFlow(INITIAL_CREATE_FLOW);
  };

  const requestHostResize = () => {
    // Forge embeds this app in an iframe. Trigger both common resize APIs.
    try {
      if (window.parentIFrame && typeof window.parentIFrame.size === 'function') {
        window.parentIFrame.size();
      }
    } catch {
      // Ignore cross-origin access failures.
    }

    try {
      const iframe = window.frameElement;
      if (iframe?.iFrameResizer && typeof iframe.iFrameResizer.resize === 'function') {
        iframe.iFrameResizer.resize();
      }
    } catch {
      // Ignore cross-origin access failures.
    }

    // Emit ready event to nudge host layout recalc after dynamic content updates.
    view.emitReadyEvent().catch(() => {});
  };

  const askForCurrentField = (flow) => {
    const currentField = flow.fields[flow.currentFieldIndex];
    if (!currentField) {
      return;
    }

    appendBotMessage(
      buildFieldPrompt(currentField, flow.currentFieldIndex, flow.fields.length),
      buildFieldOptions(currentField)
    );
  };

  const moveToAttachmentStep = (flow) => {
    const nextFlow = { ...flow, stage: 'attachments' };
    setCreateFlow(nextFlow);

    appendBotMessage(
      'You can add attachments now. Click Attach and pick files. When finished, type "done" (or type "skip").',
      [
        { label: 'Attach files', action: 'attach' },
        { label: 'Skip attachments', value: 'skip' },
        { label: 'Cancel', value: 'cancel' },
      ]
    );
  };

  const moveToConfirmStep = (flow) => {
    const answerLines = flow.fields.map((field) => {
      const answer = flow.answers[field.fieldId];
      return `- ${field.name}: ${formatAnswerForSummary(answer)}`;
    });

    const attachmentLine = !flow.allowsAttachments
      ? 'Attachments: not supported for this request type'
      : flow.attachmentNames.length > 0
      ? `Attachments: ${flow.attachmentNames.join(', ')}`
      : 'Attachments: none';

    appendBotMessage(
      `Please confirm the request details:\n` +
        `Project: ${flow.selectedProject?.projectName || ''}\n` +
        `Request type: ${flow.selectedRequestType?.name || ''}\n` +
        `${answerLines.join('\n')}\n` +
        `${attachmentLine}`,
      [
        { label: 'Create request', value: 'create' },
        { label: 'Cancel', value: 'cancel' },
      ]
    );

    setCreateFlow({ ...flow, stage: 'confirm' });
  };

  const startCreateRequestFlow = async () => {
    setLoading(true);

    try {
      const result = await invoke('getPortalCreateRequestProjects', {
        projectId: portalProject.projectId,
        projectKey: portalProject.projectKey,
        portalId: portalProject.portalId,
      });

      if (result?.error) {
        appendBotMessage(result.error);
        return;
      }

      const projects = Array.isArray(result?.projects) ? result.projects : [];
      if (projects.length === 0) {
        appendBotMessage(
          'I could not find any enabled service projects for request creation. Please ask your admin to enable project chat in Agent Settings.'
        );
        return;
      }

      const nextFlow = {
        ...INITIAL_CREATE_FLOW,
        active: true,
        stage: 'select_project',
        projects,
      };

      setCreateFlow(nextFlow);
      appendBotMessage('Sure. First, choose a project:', buildProjectOptions(projects));
    } catch {
      appendBotMessage('Could not start request creation. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateFlowInput = async (text) => {
    if (!createFlow.active) {
      return false;
    }

    if (CANCEL_FLOW_REGEX.test(text)) {
      resetCreateFlow();
      appendBotMessage('Request creation canceled.');
      return true;
    }

    if (createFlow.stage === 'select_project') {
      const selectedProject = findItemByUserInput(
        createFlow.projects,
        text,
        (project) => [project.projectName, project.portalName, project.projectKey, project.serviceDeskId]
      );

      if (!selectedProject) {
        appendBotMessage('Please choose a valid project from the list.', buildProjectOptions(createFlow.projects));
        return true;
      }

      setLoading(true);

      try {
        const result = await invoke('getPortalRequestTypes', {
          serviceDeskId: selectedProject.serviceDeskId,
          projectId: portalProject.projectId,
          projectKey: portalProject.projectKey,
          portalId: portalProject.portalId,
        });

        if (result?.error) {
          appendBotMessage(result.error);
          return true;
        }

        const requestTypes = Array.isArray(result?.requestTypes) ? result.requestTypes : [];
        if (requestTypes.length === 0) {
          appendBotMessage(
            `No request types are currently available for ${selectedProject.projectName}. Choose another project or type cancel.`,
            buildProjectOptions(createFlow.projects)
          );
          return true;
        }

        setCreateFlow((prev) => ({
          ...prev,
          stage: 'select_request_type',
          selectedProject,
          requestTypes,
        }));

        appendBotMessage(
          `Great. Now choose a request type for ${selectedProject.projectName}:`,
          buildRequestTypeOptions(requestTypes)
        );
      } catch {
        appendBotMessage('Could not load request types for that project. Please try again.');
      } finally {
        setLoading(false);
      }

      return true;
    }

    if (createFlow.stage === 'select_request_type') {
      const selectedRequestType = findItemByUserInput(
        createFlow.requestTypes,
        text,
        (requestType) => [requestType.name, requestType.id]
      );

      if (!selectedRequestType) {
        appendBotMessage(
          'Please choose a valid request type from the list.',
          buildRequestTypeOptions(createFlow.requestTypes)
        );
        return true;
      }

      setLoading(true);

      try {
        const result = await invoke('getPortalRequestTypeFields', {
          serviceDeskId: createFlow.selectedProject?.serviceDeskId,
          requestTypeId: selectedRequestType.id,
          projectId: portalProject.projectId,
          projectKey: portalProject.projectKey,
          portalId: portalProject.portalId,
        });

        if (result?.error) {
          appendBotMessage(result.error);
          return true;
        }

        const fields = Array.isArray(result?.fields) ? result.fields : [];
        const allowsAttachments = Boolean(result?.allowsAttachments);
        const nextFlow = {
          ...createFlow,
          stage: fields.length > 0 ? 'collect_fields' : allowsAttachments ? 'attachments' : 'confirm',
          selectedRequestType,
          allowsAttachments,
          fields,
          currentFieldIndex: 0,
          answers: {},
          temporaryAttachmentIds: [],
          attachmentNames: [],
        };

        setCreateFlow(nextFlow);

        if (fields.length > 0) {
          askForCurrentField(nextFlow);
        } else if (allowsAttachments) {
          moveToAttachmentStep(nextFlow);
        } else {
          moveToConfirmStep(nextFlow);
        }
      } catch {
        appendBotMessage('Could not load fields for that request type. Please try again.');
      } finally {
        setLoading(false);
      }

      return true;
    }

    if (createFlow.stage === 'collect_fields') {
      const currentField = createFlow.fields[createFlow.currentFieldIndex];
      if (!currentField) {
        if (createFlow.allowsAttachments) {
          moveToAttachmentStep(createFlow);
        } else {
          moveToConfirmStep(createFlow);
        }
        return true;
      }

      let parsedAnswer;
      if (
        currentField.inputType === 'select' ||
        currentField.inputType === 'multi_select' ||
        (Array.isArray(currentField.validValues) && currentField.validValues.length > 0)
      ) {
        const matchedOption = findItemByUserInput(
          currentField.validValues,
          text,
          (option) => [option.label, option.id, option.value]
        );

        if (!matchedOption) {
          appendBotMessage(
            `Please choose a valid option for ${currentField.name}.`,
            buildFieldOptions(currentField)
          );
          return true;
        }

        parsedAnswer = {
          id: matchedOption.id,
          value: matchedOption.value,
          label: matchedOption.label,
        };
      } else if (currentField.inputType === 'number') {
        const numericValue = Number(text);
        if (!Number.isFinite(numericValue)) {
          appendBotMessage(`Please enter a numeric value for ${currentField.name}.`);
          return true;
        }
        parsedAnswer = numericValue;
      } else {
        const normalizedText = String(text || '').trim();
        if (!normalizedText) {
          appendBotMessage(`Please provide a value for ${currentField.name}.`);
          return true;
        }
        parsedAnswer = normalizedText;
      }

      const nextAnswers = {
        ...createFlow.answers,
        [currentField.fieldId]: parsedAnswer,
      };

      if (createFlow.currentFieldIndex + 1 < createFlow.fields.length) {
        const nextFlow = {
          ...createFlow,
          answers: nextAnswers,
          currentFieldIndex: createFlow.currentFieldIndex + 1,
        };
        setCreateFlow(nextFlow);
        askForCurrentField(nextFlow);
      } else {
        const completedFlow = { ...createFlow, answers: nextAnswers };
        if (completedFlow.allowsAttachments) {
          moveToAttachmentStep(completedFlow);
        } else {
          moveToConfirmStep(completedFlow);
        }
      }

      return true;
    }

    if (createFlow.stage === 'attachments') {
      if (SKIP_STEP_REGEX.test(text)) {
        moveToConfirmStep(createFlow);
        return true;
      }

      if (ATTACH_HELP_REGEX.test(text)) {
        if (fileInputRef.current) {
          fileInputRef.current.click();
        }
        appendBotMessage('Select file(s) in the picker. Then type "done" when you are ready to continue.');
        return true;
      }

      appendBotMessage(
        'Use Attach to upload files, then type "done". Or type "skip" to continue without attachments.',
        [
          { label: 'Attach files', action: 'attach' },
          { label: 'Skip attachments', value: 'skip' },
          { label: 'Cancel', value: 'cancel' },
        ]
      );
      return true;
    }

    if (createFlow.stage === 'confirm') {
      if (!CONFIRM_REGEX.test(text)) {
        appendBotMessage('Type "create" to submit the request, or "cancel" to stop.');
        return true;
      }

      setLoading(true);

      try {
        const result = await invoke('createPortalRequest', {
          serviceDeskId: createFlow.selectedProject?.serviceDeskId,
          requestTypeId: createFlow.selectedRequestType?.id,
          fieldAnswers: createFlow.answers,
          temporaryAttachmentIds: createFlow.temporaryAttachmentIds,
          projectId: portalProject.projectId,
          projectKey: portalProject.projectKey,
          portalId: portalProject.portalId,
        });

        if (!result?.success) {
          appendBotMessage(result?.error || 'Failed to create the request. Please check the details and try again.');
          return true;
        }

        const requestSummary = [
          'Request created successfully.',
          result.issueKey ? `Issue key: ${result.issueKey}` : null,
          result.requestLink ? `Link: ${result.requestLink}` : null,
          result.warning ? `Note: ${result.warning}` : null,
        ]
          .filter(Boolean)
          .join('\n');

        appendBotMessage(requestSummary);
        resetCreateFlow();
      } catch {
        appendBotMessage('Failed to create the request. Please try again.');
      } finally {
        setLoading(false);
      }

      return true;
    }

    return false;
  };

  const handleChatLookup = async (text) => {
    setLoading(true);

    try {
      const result = await invoke('portalChat', {
        message: text,
        projectId: portalProject.projectId,
        projectKey: portalProject.projectKey,
        portalId: portalProject.portalId,
      });

      appendBotMessage(result.reply || result.error || 'Sorry, I could not process your request.');
    } catch {
      appendBotMessage('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const processUserInput = async (rawInput) => {
    const text = String(rawInput || '').trim();
    if (!text || loading) {
      return;
    }

    appendUserMessage(text);

    if (createFlow.active) {
      const handledByCreateFlow = await handleCreateFlowInput(text);
      if (handledByCreateFlow) {
        return;
      }
    }

    if (CREATE_REQUEST_INTENT_REGEX.test(text)) {
      await startCreateRequestFlow();
      return;
    }

    await handleChatLookup(text);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) {
      return;
    }

    setInput('');
    await processUserInput(text);
  };

  const handleOptionClick = async (option) => {
    if (loading) {
      return;
    }

    if (option?.action === 'attach') {
      if (!createFlow.active || createFlow.stage !== 'attachments' || !createFlow.allowsAttachments) {
        appendBotMessage('Attachments are only available during the attachment step for supported request types.');
        return;
      }
      appendUserMessage(option.label || 'Attach files');
      if (fileInputRef.current) {
        fileInputRef.current.click();
      }
      return;
    }

    const selectedValue = option?.value || option?.label || '';
    await processUserInput(selectedValue);
  };

  const uploadAttachment = async (serviceDeskId, file) => {
    const formData = new FormData();
    formData.append('file', file, file.name);

    const response = await requestJira(
      `/rest/servicedeskapi/servicedesk/${serviceDeskId}/attachTemporaryFile`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'X-Atlassian-Token': 'no-check',
        },
        body: formData,
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upload failed (${response.status}): ${text}`);
    }

    const payload = await response.json();
    const temporaryAttachment = extractTemporaryAttachment(payload);

    if (!temporaryAttachment?.id) {
      throw new Error('Upload response did not include a temporary attachment id.');
    }

    return {
      id: String(temporaryAttachment.id),
      fileName: temporaryAttachment.fileName || file.name,
    };
  };

  const handleAttachmentSelection = async (event) => {
    const files = Array.from(event.target.files || []);

    if (!createFlow.active || createFlow.stage !== 'attachments' || !createFlow.selectedProject) {
      appendBotMessage('Please start request creation first, then add attachments in the attachment step.');
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }

    if (files.length === 0) {
      return;
    }

    setLoading(true);

    const uploadedIds = [];
    const uploadedNames = [];

    for (const file of files) {
      try {
        const uploaded = await uploadAttachment(createFlow.selectedProject.serviceDeskId, file);
        uploadedIds.push(uploaded.id);
        uploadedNames.push(uploaded.fileName);
      } catch (error) {
        appendBotMessage(
          `Could not upload ${file.name}: ${error?.message || 'Upload error'}`
        );
      }
    }

    if (uploadedIds.length > 0) {
      setCreateFlow((prev) => ({
        ...prev,
        temporaryAttachmentIds: [...prev.temporaryAttachmentIds, ...uploadedIds],
        attachmentNames: [...prev.attachmentNames, ...uploadedNames],
      }));

      appendBotMessage(
        `Attached: ${uploadedNames.join(', ')}\nYou can add more files, or type "done" to continue.`
      );
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    setLoading(false);
  };

  const handleKeyDown = async (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      await handleSend();
    }
  };

  const inputPlaceholder = (() => {
    if (!createFlow.active) {
      return 'Ask about an issue, or type "I want to create a request"';
    }

    if (createFlow.stage === 'select_project') {
      return 'Type the project number or name...';
    }

    if (createFlow.stage === 'select_request_type') {
      return 'Type the request type number or name...';
    }

    if (createFlow.stage === 'collect_fields') {
      const currentField = createFlow.fields[createFlow.currentFieldIndex];
      return currentField ? `Enter ${currentField.name}...` : 'Enter a value...';
    }

    if (createFlow.stage === 'attachments') {
      return 'Type done to continue, or skip to continue without files...';
    }

    if (createFlow.stage === 'confirm') {
      return 'Type create to submit, or cancel...';
    }

    return 'Type your message...';
  })();

  /* Load current portal context and decide if widget should render */
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

  /* Auto-scroll when new messages arrive. */
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, loading]);

  /* Hide tooltip after first few seconds. */
  useEffect(() => {
    const timer = setTimeout(() => setTooltipVisible(false), 8000);
    return () => clearTimeout(timer);
  }, []);

  /* Show tooltip again when chat is closed. */
  useEffect(() => {
    if (!open) {
      const timer = setTimeout(() => setTooltipVisible(true), 1000);
      return () => clearTimeout(timer);
    }

    setTooltipVisible(false);
    return undefined;
  }, [open]);

  /* Recalculate host iframe height after content or visibility changes. */
  useEffect(() => {
    const frameHandle = window.requestAnimationFrame(() => requestHostResize());
    const timeoutHandle = window.setTimeout(() => requestHostResize(), 160);

    return () => {
      window.cancelAnimationFrame(frameHandle);
      window.clearTimeout(timeoutHandle);
    };
  }, [open, messages.length, loading, createFlow.stage]);

  if (checkingAvailability) {
    return null;
  }

  // Hide only when explicitly disabled. Keep visible on global portal pages
  // where a specific project context is not available.
  const shouldHideWidget = !chatEnabledForProject && availabilityReason !== 'missing_project_context';

  if (shouldHideWidget) {
    return null;
  }

  return (
    <div style={s.root}>
      <style>{keyframes}</style>
      <style>{globalLayoutFix}</style>

      {open && (
        <div style={s.chatWindow}>
          <div style={s.header}>
            <div style={s.headerIcon}>
              <ChatIcon />
            </div>
            <div style={{ flex: 1 }}>
              <div style={s.headerTitle}>Jira Assistant</div>
              <div style={s.headerSubtitle}>Status checks and request creation</div>
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

          <div style={s.chatArea}>
            {messages.map((message) => (
              <div key={message.id}>
                {message.role === 'bot' && <div style={s.botLabel}>Jira Assistant</div>}
                <div style={s.bubble(message.role === 'user')}>{message.content}</div>

                {message.role === 'bot' && Array.isArray(message.options) && message.options.length > 0 && (
                  <div style={s.optionWrap}>
                    {message.options.map((option, index) => (
                      <button
                        key={`${message.id}-option-${index}`}
                        type="button"
                        style={s.optionBtn}
                        disabled={loading}
                        onClick={() => handleOptionClick(option)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
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

          {createFlow.active && createFlow.stage === 'attachments' && createFlow.allowsAttachments && (
            <div style={s.attachmentStrip}>
              <div style={s.attachmentSummary}>
                {createFlow.attachmentNames.length > 0
                  ? `Attached: ${createFlow.attachmentNames.join(', ')}`
                  : 'No attachments added yet.'}
              </div>
              <button
                type="button"
                style={s.attachBtn}
                onClick={() => fileInputRef.current?.click()}
                disabled={loading}
              >
                <AttachmentIcon />
                <span>Attach</span>
              </button>
            </div>
          )}

          <div style={s.inputArea}>
            <input
              style={s.input}
              type="text"
              placeholder={inputPlaceholder}
              value={input}
              onChange={(event) => setInput(event.target.value)}
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

          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleAttachmentSelection}
          />
        </div>
      )}

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
          onClick={() => setOpen((previous) => !previous)}
          aria-label={open ? 'Close chat' : 'Open chat'}
        >
          {open ? <CloseIcon /> : <ChatIcon />}
        </button>
      </div>
    </div>
  );
}

const s = {
  root: {
    width: '100%',
    maxWidth: 620,
    minHeight: 56,
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
    background: isOpen ? '#344563' : 'linear-gradient(135deg, #0065FF 0%, #0052CC 100%)',
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

  chatWindow: {
    width: '100%',
    maxWidth: 560,
    maxHeight: 'calc(100vh - 92px)',
    minHeight: 320,
    borderRadius: 16,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    background: '#FFFFFF',
    boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
    animation: 'slideUp 0.3s ease-out',
  },

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

  headerTitle: {
    fontSize: 16,
    fontWeight: 600,
  },

  headerSubtitle: {
    fontSize: 12,
    opacity: 0.85,
    marginTop: 2,
  },

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

  chatArea: {
    maxHeight: 'min(58vh, 560px)',
    minHeight: 120,
    overflowY: 'auto',
    padding: 14,
    background: '#F4F5F7',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },

  bubble: (isUser) => ({
    maxWidth: '90%',
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

  optionWrap: {
    marginTop: 8,
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    maxWidth: '94%',
  },

  optionBtn: {
    border: '1px solid #0052CC',
    background: '#FFFFFF',
    color: '#0052CC',
    borderRadius: 999,
    padding: '6px 10px',
    fontSize: 12,
    lineHeight: 1.2,
    cursor: 'pointer',
  },

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

  attachmentStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    borderTop: '1px solid #DFE1E6',
    background: '#FAFBFC',
  },

  attachmentSummary: {
    flex: 1,
    fontSize: 12,
    color: '#42526E',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  attachBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    border: '1px solid #0052CC',
    background: '#FFFFFF',
    color: '#0052CC',
    borderRadius: 999,
    padding: '6px 10px',
    fontSize: 12,
    cursor: 'pointer',
  },

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
