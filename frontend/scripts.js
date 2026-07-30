const GPTResearcher = (() => {
  let isResearchActive = false;
  let connectionTimeout = null;
  let conversationHistory = [];
  let isInitialLoad = true; // Flag to track initial page load
  let cookiesEnabled = true; // Flag to track if cookies are enabled
  let allReports = ''; // Store all reports cumulatively
  let currentReport = ''; // Store the current report (will be overwritten)
  let isFirstReport = true; // Flag to track if this is the first report
  let chatContainer = null; // Global reference to chat container
  let lastRequestData = null; // Store the last request data for reconnection
  let chatMessagesState = []; // User/assistant history sent with follow-up questions
  let workspaceProgressStarted = false; // Tracks whether progress has content worth showing
  let currentDownloadLinks = null; // Download links for the restored/current report
  let currentCompetitiveAnalysis = null; // Competitive analysis metadata for the current report

  // Add WebSocket monitoring variables
  let socket = null;
  let connectionStartTime = null;
  let lastActivityTime = null;
  let connectionAttempts = 0;
  let messagesReceived = 0;
  let websocketMonitorInterval = null;
  let dispose_socket = null; // Re-add dispose_socket
  let reconnectAttempts = 0;
  let maxReconnectAttempts = 5;
  let reconnectInterval = 2000; // Start with 2 seconds
  const DEFAULT_REPORT_TYPE = 'research_report';
  const DEFAULT_TONE = 'Objective';
  const WORKSPACE_SNAPSHOT_KEY = 'currentResearchWorkspace';

  const init = () => {
    // Check if cookies are enabled
    checkCookiesEnabled();

    // Load history immediately on page load
    loadConversationHistory();
    loadServerHistory();

    // After a short delay, mark initial load as complete
    setTimeout(() => {
      isInitialLoad = false;
    }, 1000);

    // Setup form submission
    document.getElementById('researchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      startResearch();
      return false;
    });

    document
      .getElementById('copyToClipboard')
      .addEventListener('click', copyToClipboard)

    // Add event listener for the top copy button
    const topCopyButton = document.getElementById('copyToClipboardTop');
    if (topCopyButton) {
      topCopyButton.addEventListener('click', copyToClipboard);
    }

    // Initialize expand buttons
    initExpandButtons();
    initWorkspaceTabs();
    initWorkspaceProgress();

    // Initialize history panel functionality
    initHistoryPanel();

    // Initialize WebSocket monitoring panel
    initWebSocketPanel();

    // The download bar is now fixed in place with CSS
    // No need to set display property here

    updateState('initial');
    setWorkspaceChatAvailable(false);
    hideWorkspaceProgress();

    // Initialize research icon to not spinning
    updateResearchIcon(false);

    // Hide loading overlay if it exists
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
      loadingOverlay.classList.add('loading-hidden');
    }

    restoreWorkspaceSnapshot();
  }

  const setDownloadBarVisibilityForWorkspace = (target) => {
    const stickyDownloadsBar = document.getElementById('stickyDownloadsBar');
    if (!stickyDownloadsBar) return;
    stickyDownloadsBar.classList.toggle('is-workspace-hidden', target !== 'report');
  }

  const activateWorkspaceView = (target) => {
    const tabs = document.querySelectorAll('[data-workspace-tab]');
    const views = document.querySelectorAll('[data-workspace-view]');
    const targetTab = document.querySelector(`[data-workspace-tab="${target}"]`);

    if (targetTab && targetTab.hidden) return;

    tabs.forEach((tab) => {
      const isActive = tab.dataset.workspaceTab === target;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    views.forEach((view) => {
      view.classList.toggle('is-active', view.dataset.workspaceView === target);
    });

    syncWorkspaceProgressVisibility(target);
    setDownloadBarVisibilityForWorkspace(target);
    if (currentReport) {
      persistCurrentWorkspaceSnapshot();
    }
  }

  const getActiveWorkspaceTarget = () => {
    const activeTab = document.querySelector('[data-workspace-tab].is-active');
    return activeTab ? activeTab.dataset.workspaceTab : 'report';
  }

  const setWorkspaceChatAvailable = (available) => {
    const chatTab = document.getElementById('workspaceChatTab');
    const chatView = document.querySelector('[data-workspace-view="chat"]');
    if (!chatTab || !chatView) return;

    chatTab.hidden = !available;
    chatView.hidden = !available;

    if (!available && chatView.classList.contains('is-active')) {
      activateWorkspaceView('report');
    }
  }

  const initWorkspaceTabs = () => {
    const tabs = document.querySelectorAll('[data-workspace-tab]');
    if (!tabs.length) return;

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        activateWorkspaceView(tab.dataset.workspaceTab);
      });
    });
  }

  const setWorkspaceProgressCollapsed = (collapsed) => {
    const workspaceProgress = document.getElementById('workspaceProgress');
    const toggle = document.getElementById('workspaceProgressToggle');

    if (!workspaceProgress || !toggle) return;

    workspaceProgress.classList.toggle('is-collapsed', collapsed);
    workspaceProgress.classList.toggle('is-open', !collapsed);
    toggle.textContent = collapsed ? '打开研究进度' : '收起研究进度';
    toggle.title = collapsed ? '展开研究进度' : '收起研究进度';
  }

  const showWorkspaceProgress = () => {
    const workspaceProgress = document.getElementById('workspaceProgress');
    if (!workspaceProgress) return;
    workspaceProgressStarted = true;
    syncWorkspaceProgressVisibility();
  }

  const hideWorkspaceProgress = () => {
    const workspaceProgress = document.getElementById('workspaceProgress');
    if (!workspaceProgress) return;
    workspaceProgressStarted = false;
    setWorkspaceProgressCollapsed(true);
    workspaceProgress.hidden = true;
  }

  const syncWorkspaceProgressVisibility = (target = getActiveWorkspaceTarget()) => {
    const workspaceProgress = document.getElementById('workspaceProgress');
    if (!workspaceProgress) return;

    if (!workspaceProgressStarted || target === 'chat') {
      workspaceProgress.hidden = true;
      return;
    }

    workspaceProgress.hidden = false;
  }

  const expandWorkspaceProgress = () => {
    showWorkspaceProgress();
    setWorkspaceProgressCollapsed(false);
  }

  const collapseWorkspaceProgress = () => {
    setWorkspaceProgressCollapsed(true);
  }

  const initWorkspaceProgress = () => {
    const toggle = document.getElementById('workspaceProgressToggle');
    const workspaceProgress = document.getElementById('workspaceProgress');
    if (!toggle || !workspaceProgress) return;

    setWorkspaceProgressCollapsed(workspaceProgress.classList.contains('is-collapsed'));
    toggle.addEventListener('click', () => {
      setWorkspaceProgressCollapsed(!workspaceProgress.classList.contains('is-collapsed'));
    });
  }

  const getWorkspaceSnapshotPayload = () => {
    const report = currentReport && currentReport.trim() ? currentReport : '';
    if (!report) return null;

    return {
      version: 1,
      timestamp: Date.now(),
      prompt: document.getElementById('task')?.value || '',
      report,
      links: currentDownloadLinks || {},
      competitiveAnalysis: currentCompetitiveAnalysis || null,
      activeWorkspaceTab: getActiveWorkspaceTarget(),
      reportSource: document.querySelector('select[name="report_source"]')?.value || 'web',
      queryDomains: splitListInput(document.querySelector('input[name="query_domains"]')?.value || ''),
      competitiveResearch: getCompetitiveResearchData(),
      chatMessages: chatMessagesState
        .filter((message) => message && message.role && message.content)
        .map((message) => ({
          role: message.role,
          content: message.content
        }))
    };
  }

  const persistCurrentWorkspaceSnapshot = () => {
    try {
      const snapshot = getWorkspaceSnapshotPayload();
      if (!snapshot) return;
      localStorage.setItem(WORKSPACE_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn('Unable to persist current workspace snapshot:', error);
    }
  }

  const clearWorkspaceSnapshot = () => {
    try {
      localStorage.removeItem(WORKSPACE_SNAPSHOT_KEY);
    } catch (error) {
      console.warn('Unable to clear current workspace snapshot:', error);
    }
  }

  const restoreChatMessages = (messages = []) => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages || !Array.isArray(messages) || !messages.length) return;

    const normalizedMessages = messages
      .filter((message) => message && ['user', 'assistant'].includes(message.role) && message.content)
      .map((message) => ({
        role: message.role,
        content: message.content
      }));

    if (!normalizedMessages.length) return;

    chatMessages.innerHTML = '';
    chatMessagesState = [];
    normalizedMessages.forEach((message) => {
      addChatMessage(message.content, message.role === 'user', false);
    });
    chatMessagesState = normalizedMessages;
  }

  const restoreWorkspaceSnapshot = () => {
    try {
      const rawSnapshot = localStorage.getItem(WORKSPACE_SNAPSHOT_KEY);
      if (!rawSnapshot) return false;

      const snapshot = JSON.parse(rawSnapshot);
      if (!snapshot || !snapshot.report) return false;

      const taskInput = document.getElementById('task');
      if (taskInput && snapshot.prompt) {
        taskInput.value = snapshot.prompt;
      }

      const reportSourceSelect = document.querySelector('select[name="report_source"]');
      if (reportSourceSelect && snapshot.reportSource) {
        reportSourceSelect.value = snapshot.reportSource;
      }

      const queryDomainsInput = document.querySelector('input[name="query_domains"]');
      if (queryDomainsInput && Array.isArray(snapshot.queryDomains)) {
        queryDomainsInput.value = snapshot.queryDomains.join(', ');
      }

      currentReport = snapshot.report;
      allReports = snapshot.report;
      currentDownloadLinks = snapshot.links || {};
      currentCompetitiveAnalysis = snapshot.competitiveAnalysis || currentDownloadLinks.competitive_analysis_data || null;

      const converter = new showdown.Converter({
        ghCodeBlocks: true,
        tables: true,
        tasklists: true,
        smartIndentationFix: true,
        simpleLineBreaks: true,
        openLinksInNewWindow: true,
        parseImgDimensions: true
      });

      writeReport({ output: snapshot.report, type: 'report' }, converter, true, false);
      updateState('finished');
      updateDownloadLink({
        output: {
          ...currentDownloadLinks,
          competitive_analysis_data: currentCompetitiveAnalysis
        }
      });
      restoreChatMessages(snapshot.chatMessages || []);
      collapseWorkspaceProgress();
      setWorkspaceChatAvailable(true);
      activateWorkspaceView(snapshot.activeWorkspaceTab === 'chat' ? 'chat' : 'report');
      return true;
    } catch (error) {
      console.warn('Unable to restore current workspace snapshot:', error);
      clearWorkspaceSnapshot();
      return false;
    }
  }

  // Check if cookies are enabled
  const checkCookiesEnabled = () => {
    try {
      // Try to set a test cookie
      document.cookie = "testcookie=1; path=/";
      const cookieEnabled = document.cookie.indexOf("testcookie") !== -1;

      if (!cookieEnabled) {
        console.warn("Cookies are disabled in this browser");
        cookiesEnabled = false;
        showToast("当前浏览器禁用 Cookie，研究历史将改用 localStorage。", 5000);
      } else {
        // Clean up test cookie
        document.cookie = "testcookie=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        cookiesEnabled = true;
      }

      return cookieEnabled;
    } catch (e) {
      console.error("Error checking cookies:", e);
      cookiesEnabled = false;
      return false;
    }
  }

  // Initialize conversation history panel functionality
  const initHistoryPanel = () => {
    // Load history from cookie
    loadConversationHistory();

    // Setup history panel toggle button
    const historyPanelOpenBtn = document.getElementById('historyPanelOpenBtn');
    const historyPanel = document.getElementById('historyPanel');
    const historyPanelToggle = document.getElementById('historyPanelToggle');

    if (historyPanelOpenBtn) {
      historyPanelOpenBtn.addEventListener('click', () => {
        loadConversationHistory(); // Reload history when opening panel
        loadServerHistory();
        historyPanel.classList.add('open');
      });
    }

    if (historyPanelToggle) {
      historyPanelToggle.addEventListener('click', () => {
        historyPanel.classList.remove('open');
      });
    }

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
      // If the panel is open and the click is outside the panel and not on the toggle button
      if (historyPanel.classList.contains('open') &&
        !historyPanel.contains(e.target) &&
        e.target !== historyPanelOpenBtn &&
        !historyPanelOpenBtn.contains(e.target)) {
        historyPanel.classList.remove('open');
      }
    });

    // Setup search functionality
    const historySearch = document.getElementById('historySearch');
    const historySearchBtn = document.getElementById('historySearchBtn');

    if (historySearch && historySearchBtn) {
      historySearch.addEventListener('input', filterHistoryEntries);
      historySearchBtn.addEventListener('click', () => filterHistoryEntries());
    }

    // Setup sort functionality
    const historySortOrder = document.getElementById('historySortOrder');
    if (historySortOrder) {
      historySortOrder.addEventListener('change', () => {
        sortHistoryEntries(historySortOrder.value);
        renderHistoryEntries();
      });
    }

    // Setup clear history button
    const historyClearBtn = document.getElementById('historyClearBtn');
    if (historyClearBtn) {
      historyClearBtn.addEventListener('click', clearConversationHistory);
    }

    // Add action buttons to history panel
    const historyFilters = document.querySelector('.history-panel-filters');
    if (historyFilters) {
      // Create a container for the buttons
      const actionsContainer = document.createElement('div');
      actionsContainer.className = 'history-actions-container';

      // Add export history button with enhanced styling and tooltip
      const exportBtn = document.createElement('button');
      exportBtn.className = 'history-action-btn';
      exportBtn.title = '导出研究历史到文件';
      exportBtn.innerHTML = '<i class="fas fa-file-export"></i>';
      exportBtn.addEventListener('click', exportHistory);

      // Add import history button with enhanced styling and tooltip
      const importBtn = document.createElement('button');
      importBtn.className = 'history-action-btn';
      importBtn.title = '从文件导入研究历史';
      importBtn.innerHTML = '<i class="fas fa-file-import"></i>';
      importBtn.addEventListener('click', triggerImportHistory);

      // Add cookie debug button with enhanced styling and tooltip
      const debugBtn = document.createElement('button');
      debugBtn.className = 'history-action-btn';
      debugBtn.title = '检查存储状态';
      debugBtn.innerHTML = '<i class="fas fa-database"></i>';
      debugBtn.addEventListener('click', checkCookieStatus);

      // Add buttons to container in a logical order
      actionsContainer.appendChild(importBtn);
      actionsContainer.appendChild(exportBtn);
      actionsContainer.appendChild(debugBtn);

      // Create a hidden file input for importing
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.id = 'historyFileInput';
      fileInput.accept = '.json';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', handleFileImport);

      // Add container and file input to filters
      historyFilters.appendChild(actionsContainer);
      historyFilters.appendChild(fileInput);
    }

    // Initial render of history entries
    renderHistoryEntries();
  }

  // Initialize WebSocket monitoring panel
  const initWebSocketPanel = () => {
    const websocketPanel = document.getElementById('websocketPanel');
    const websocketPanelOpenBtn = document.getElementById('websocketPanelOpenBtn');
    const websocketPanelToggle = document.getElementById('websocketPanelToggle');

    if (!websocketPanel || !websocketPanelOpenBtn || !websocketPanelToggle) {
      console.error("WebSocket panel elements not found");
      return;
    }

    console.log("Initializing WebSocket panel");

    // Ensure it starts hidden
    websocketPanel.classList.remove('open');

    websocketPanelOpenBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("Opening WebSocket panel");
      websocketPanel.classList.add('open');
    });

    websocketPanelToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log("Closing WebSocket panel");
      websocketPanel.classList.remove('open');
    });

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
      // If the panel is open and the click is outside the panel and not on the toggle button
      if (websocketPanel.classList.contains('open') &&
        !websocketPanel.contains(e.target) &&
        e.target !== websocketPanelOpenBtn &&
        !websocketPanelOpenBtn.contains(e.target)) {
        websocketPanel.classList.remove('open');
      }
    });

    // Start periodic WebSocket status updates
    startWebSocketMonitoring();
  }

  // Start WebSocket monitoring
  const startWebSocketMonitoring = () => {
    console.log("Starting WebSocket monitoring");

    // Update status immediately
    updateWebSocketStatus();

    // Clear any existing interval
    if (websocketMonitorInterval) {
      clearInterval(websocketMonitorInterval);
    }

    // Update status every 2 seconds
    websocketMonitorInterval = setInterval(updateWebSocketStatus, 2000);
  }

  // Update WebSocket status in the panel
  const updateWebSocketStatus = () => {
    // Only proceed if the necessary elements exist
    const connectionStatusEl = document.getElementById('connectionStatus');
    const connectionIndicatorEl = document.getElementById('connectionIndicator');
    const researchStatusEl = document.getElementById('researchStatus');
    const connectionDurationEl = document.getElementById('connectionDuration');
    const lastActivityEl = document.getElementById('lastActivity');
    const readyStateEl = document.getElementById('readyState');
    const connectionAttemptsEl = document.getElementById('connectionAttempts');
    const messagesReceivedEl = document.getElementById('messagesReceived');
    const currentTaskEl = document.getElementById('currentTask');

    if (!connectionStatusEl || !connectionIndicatorEl) return;

    // Update connection status
    const socketStatus = getSocketStatus();
    connectionStatusEl.textContent = socketStatus.statusText;

    // Update indicator class
    connectionIndicatorEl.className = 'status-indicator';
    connectionIndicatorEl.classList.add(socketStatus.indicatorClass);

    // Update research status
    if (researchStatusEl) {
      researchStatusEl.textContent = isResearchActive ? '进行中' : '未开始';
    }

    // Update connection duration
    if (connectionDurationEl && connectionStartTime) {
      const duration = Math.floor((Date.now() - connectionStartTime) / 1000);
      connectionDurationEl.textContent = formatDuration(duration);
    } else if (connectionDurationEl) {
      connectionDurationEl.textContent = '-';
    }

    // Update last activity
    if (lastActivityEl && lastActivityTime) {
      const elapsed = Math.floor((Date.now() - lastActivityTime) / 1000);
      lastActivityEl.textContent = elapsed < 60 ? `${elapsed} 秒前` : formatDuration(elapsed) + '前';
    } else if (lastActivityEl) {
      lastActivityEl.textContent = '-';
    }

    // Update ReadyState
    if (readyStateEl && socket) {
      readyStateEl.textContent = getReadyStateText(socket.readyState);
    } else if (readyStateEl) {
      readyStateEl.textContent = '-';
    }

    // Update connection attempts
    if (connectionAttemptsEl) {
      connectionAttemptsEl.textContent = connectionAttempts.toString();
    }

    // Update messages received
    if (messagesReceivedEl) {
      messagesReceivedEl.textContent = messagesReceived.toString();
    }

    // Update current task
    if (currentTaskEl) {
      const taskInput = document.getElementById('task');
      currentTaskEl.textContent = isResearchActive && taskInput && taskInput.value ?
        (taskInput.value.length > 30 ? taskInput.value.substring(0, 27) + '...' : taskInput.value) :
        '-';
    }
  }

  // Get socket status object
  const getSocketStatus = () => {
    if (!socket) {
      return {
        statusText: '未连接',
        indicatorClass: 'disconnected'
      };
    }

    switch (socket.readyState) {
      case WebSocket.CONNECTING:
        return {
          statusText: '连接中',
          indicatorClass: 'connecting'
        };
      case WebSocket.OPEN:
        return {
          statusText: '已连接',
          indicatorClass: 'connected'
        };
      case WebSocket.CLOSING:
        return {
          statusText: '正在关闭',
          indicatorClass: 'connecting'
        };
      case WebSocket.CLOSED:
      default:
        return {
          statusText: '未连接',
          indicatorClass: 'disconnected'
        };
    }
  }

  // Get readable text for WebSocket readyState
  const getReadyStateText = (readyState) => {
    switch (readyState) {
      case WebSocket.CONNECTING:
        return '0（连接中）';
      case WebSocket.OPEN:
        return '1（已打开）';
      case WebSocket.CLOSING:
        return '2（正在关闭）';
      case WebSocket.CLOSED:
        return '3（已关闭）';
      default:
        return `${readyState}（未知）`;
    }
  }

  // Format duration in seconds to human-readable string
  const formatDuration = (seconds) => {
    if (seconds < 60) {
      return `${seconds} 秒`;
    } else if (seconds < 3600) {
      return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    } else {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      return `${hours} 小时 ${minutes} 分`;
    }
  }

  // Load conversation history from cookie
  const loadConversationHistory = () => {
    try {
      const storedHistory = getCookie('conversationHistory');
      if (storedHistory && storedHistory.trim() !== '') {
        try {
          const parsedHistory = JSON.parse(storedHistory);
          if (Array.isArray(parsedHistory)) {
            conversationHistory = parsedHistory;
            console.debug('Loaded research history from storage:', conversationHistory);
            console.log('Loaded research history:', conversationHistory.length, 'items');
          } else {
            console.warn('History storage does not contain an array');
            conversationHistory = [];
            deleteCookie('conversationHistory');
          }
        } catch (jsonError) {
          console.error('Invalid JSON in history storage:', jsonError);
          conversationHistory = [];
          deleteCookie('conversationHistory');
        }
      } else {
        console.log('No research history found in storage');
        conversationHistory = [];
      }
    } catch (error) {
      console.error('Error loading research history from storage:', error);
      conversationHistory = [];
      // If JSON parsing fails, delete the corrupt cookie
      deleteCookie('conversationHistory');
    }

    // Force render after loading
    renderHistoryEntries();
  }

  const getReportIdFromLinks = (links) => {
    const firstPath = links?.md || links?.docx || links?.pdf || links?.json || '';
    if (!firstPath) return '';
    try {
      const decodedPath = decodeURIComponent(firstPath);
      const filename = decodedPath.split(/[\\/]/).pop() || '';
      return filename.replace(/\.[^.]+$/, '');
    } catch (error) {
      console.warn('Unable to derive report id from links:', error);
      return '';
    }
  }

  const normalizeServerReport = (report) => {
    const metadata = report.metadata || {};
    return {
      id: report.id,
      prompt: report.question || metadata.originalTask || '未命名研究',
      content: report.answer || '',
      links: report.links || {},
      timestamp: report.timestamp || Date.now(),
      reportType: metadata.reportType,
      reportSource: metadata.reportSource,
      tone: metadata.tone,
      queryDomains: metadata.queryDomains || [],
      competitiveResearch: metadata.competitiveResearch || null,
      competitiveAnalysis: metadata.competitiveAnalysis || null,
      intermediateResults: metadata.intermediateResults || null,
      competitiveMatrix: metadata.competitiveMatrix || null,
      qualityStats: metadata.qualityStats || null,
      source: 'server'
    };
  }

  const mergeHistoryEntries = (entries) => {
    const merged = [];
    const seen = new Set();

    [...entries, ...(conversationHistory || [])].forEach((entry) => {
      if (!entry) return;
      const key = entry.id || getReportIdFromLinks(entry.links) || `${entry.prompt}-${entry.timestamp}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(entry);
    });

    conversationHistory = merged;
  }

  const loadServerHistory = async () => {
    try {
      const response = await fetch('/api/reports');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      const reports = Array.isArray(payload.reports) ? payload.reports : [];
      const serverEntries = reports.map(normalizeServerReport);
      mergeHistoryEntries(serverEntries);
      renderHistoryEntries();
    } catch (error) {
      console.warn('Unable to load server-side research history:', error);
    }
  }

  const persistHistoryEntry = async (entry, metadata = {}) => {
    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          id: entry.id,
          question: entry.prompt,
          answer: entry.content || '',
          links: entry.links || {},
          timestamp: entry.timestamp,
          metadata
        })
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return true;
    } catch (error) {
      console.error('Error saving research to server:', error);
      showToast('报告已保存在浏览器历史，但后端持久化失败。');
      return false;
    }
  }

  // Save conversation history to cookie
  const saveConversationHistory = () => {
    try {
      if (conversationHistory.length === 0) {
        deleteCookie('conversationHistory');
        console.debug('No history to save, deleted storage');
        return;
      }

      // Only keep the last 20 entries
      let storageHistory = [...conversationHistory];
      if (storageHistory.length > 20) {
        storageHistory = storageHistory.slice(0, 20);
        console.debug('Trimmed history to last 20 entries');
      }

      // Only keep minimal fields: prompt, links and timestamp
      storageHistory = storageHistory.map(entry => ({
        id: entry.id || getReportIdFromLinks(entry.links),
        prompt: entry.prompt || '',
        links: entry.links || {},
        timestamp: entry.timestamp || new Date().toISOString()
      }));

      const jsonString = JSON.stringify(storageHistory);
      console.debug('History JSON size:', jsonString.length, 'characters');

      setCookie('conversationHistory', jsonString, 30);

      if (storageHistory.length > 0 && !isInitialLoad) {
        showToast('研究历史已保存');
      }
    } catch (error) {
      console.error('Error saving research history:', error);
      showToast('保存研究历史失败，部分记录可能没有保存。');
    }
  }

  // Delete a history entry
  const deleteHistoryEntry = (index) => {
    if (confirm('确定要删除这条研究记录吗？')) {
      conversationHistory.splice(index, 1);
      saveConversationHistory();
      renderHistoryEntries();
      showToast('记录已删除');
    }
  }

  // Clear all conversation history
  const clearConversationHistory = () => {
    if (confirm('确定要清空全部研究历史吗？此操作不可撤销。')) {
      conversationHistory = [];
      saveConversationHistory();
      renderHistoryEntries();
      showToast('研究历史已清空');
    }
  }

  // Filter history entries based on search term
  const filterHistoryEntries = () => {
    const searchTerm = document.getElementById('historySearch').value.toLowerCase();
    const historyEntries = document.getElementById('historyEntries');

    if (!historyEntries) return;

    const entries = historyEntries.querySelectorAll('.history-entry');

    entries.forEach(entry => {
      const title = entry.querySelector('.history-entry-title').textContent.toLowerCase();
      // Search only in the title since we no longer have preview text
      if (title.includes(searchTerm)) {
        entry.style.display = 'block';
      } else {
        entry.style.display = 'none';
      }
    });
  }

  // Sort history entries by timestamp
  const sortHistoryEntries = (order) => {
    conversationHistory.sort((a, b) => {
      // Default to newest first if timestamps don't exist
      if (!a.timestamp || !b.timestamp) return 0;

      if (order === 'newest') {
        return new Date(b.timestamp) - new Date(a.timestamp);
      } else {
        return new Date(a.timestamp) - new Date(b.timestamp);
      }
    });
  }

  // Render history entries in the panel
  const renderHistoryEntries = () => {
    const historyEntries = document.getElementById('historyEntries');
    if (!historyEntries) return;

    historyEntries.innerHTML = '';

    if (!conversationHistory || conversationHistory.length === 0) {
      historyEntries.innerHTML = '<p class="text-center mt-4 text-muted">还没有研究历史。</p>';
      return;
    }

    // Sort by the current selection
    const sortOrder = document.getElementById('historySortOrder')?.value || 'newest';
    sortHistoryEntries(sortOrder);
    console.debug('Sorted history entries:', sortOrder);

    conversationHistory.forEach((entry, index) => {
      const entryElement = document.createElement('div');
      entryElement.className = 'history-entry';
      entryElement.setAttribute('data-id', index);

      // Make the entire entry clickable to load it
      entryElement.addEventListener('click', () => {
        loadResearchEntry(index);
      });

      // Format timestamp if available
      let timestampHTML = '';
      if (entry.timestamp) {
        try {
          const timestamp = new Date(entry.timestamp);
          const formattedDate = timestamp.toLocaleDateString();
          const formattedTime = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          timestampHTML = `<span class="history-entry-timestamp">${formattedDate} ${formattedTime}</span>`;
        } catch (e) {
          console.error('Error formatting timestamp:', e);
        }
      }

      // Make sure links object exists
      const links = entry.links || {};

      // Build the HTML for the entry with enhanced formatting
      entryElement.innerHTML = `
        <div class="history-entry-header">
          <h4 class="history-entry-title">${entry.prompt || '未命名研究'}</h4>
          ${timestampHTML}
        </div>
        <div class="history-entry-format">
          ${links.pdf ? `<a href="${links.pdf}" class="history-entry-action" target="_blank" title="打开 PDF 报告"><i class="fas fa-file-pdf"></i> PDF</a>` : ''}
          ${links.docx ? `<a href="${links.docx}" class="history-entry-action" target="_blank" title="打开 Word 文档"><i class="fas fa-file-word"></i> Word</a>` : ''}
          ${links.md ? `<a href="${links.md}" class="history-entry-action" target="_blank" title="打开 Markdown 文件"><i class="fas fa-file-lines"></i> MD</a>` : ''}
          ${links.json ? `<a href="${links.json}" class="history-entry-action" target="_blank" title="打开 JSON 数据"><i class="fas fa-file-code"></i> JSON</a>` : ''}
        </div>
        <div class="history-entry-actions">
          <button class="history-entry-action delete-entry" title="删除这条研究记录"><i class="fas fa-trash-alt"></i></button>
        </div>
      `;

      // Add action button handlers
      const deleteBtn = entryElement.querySelector('.delete-entry');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          deleteHistoryEntry(index);
        });
      }

      historyEntries.appendChild(entryElement);
      setTimeout(() => {
        entryElement.style.animationDelay = `${index * 50}ms`;
      }, 0);
    });
  }

  // Load a research entry from history
  const loadResearchEntry = (index) => {
    const entry = conversationHistory[index];
    if (!entry) return;

    // Fill form with the entry data
    document.getElementById('task').value = entry.prompt; // Changed from entry.task for consistency
    
    const reportSourceSelect = document.querySelector('select[name="report_source"]');
    if (reportSourceSelect && entry.reportSource) {
        reportSourceSelect.value = entry.reportSource;
    } else if (reportSourceSelect) {
        reportSourceSelect.value = reportSourceSelect.options[0].value; // Default to first option
    }

    const queryDomainsInput = document.querySelector('input[name="query_domains"]');
    if (queryDomainsInput) {
        if (entry.queryDomains && Array.isArray(entry.queryDomains) && entry.queryDomains.length > 0) {
            queryDomainsInput.value = entry.queryDomains.join(', ');
        } else {
            queryDomainsInput.value = ''; // Clear if not present
        }
    }

    // Clear current research/report areas
    document.getElementById('output').innerHTML = '';
    document.getElementById('reportContainer').innerHTML = '';
    renderCompetitiveAnalysis(null);
    document.getElementById('selectedImagesContainer').innerHTML = '';
    document.getElementById('selectedImagesContainer').style.display = 'none';

    // Hide download bar and chat
    const stickyDownloadsBar = document.getElementById('stickyDownloadsBar');
    if (stickyDownloadsBar) {
        stickyDownloadsBar.classList.remove('visible');
    }
    const chatContainer = document.getElementById('chatContainer');
    if (chatContainer) {
        chatContainer.style.display = 'none';
    }
    chatMessagesState = [];

    // Reset UI state and report-specific buttons
    updateState('initial'); // This will hide copy buttons etc.
    setWorkspaceChatAvailable(false);
    hideWorkspaceProgress();

    const reportContent = entry.content || entry.answer || '';
    if (reportContent) {
      const converter = new showdown.Converter({
        ghCodeBlocks: true,
        tables: true,
        tasklists: true,
        smartIndentationFix: true,
        simpleLineBreaks: true,
        openLinksInNewWindow: true,
        parseImgDimensions: true
      });
      currentReport = reportContent;
      allReports = reportContent;
      writeReport({ output: reportContent, type: 'report' }, converter, true, false);
      updateState('finished');
      updateDownloadLink({ output: entry.links || {} });
      currentDownloadLinks = entry.links || currentDownloadLinks;
      currentCompetitiveAnalysis = entry.competitiveAnalysis || null;
      renderCompetitiveAnalysis(entry.competitiveAnalysis || {
        request: entry.competitiveResearch || {},
        intermediate_results: entry.intermediateResults || {},
        competitive_matrix: entry.competitiveMatrix || {},
        ...(entry.qualityStats ? {
          section_completion_rate: entry.qualityStats.sectionCompletionRate,
          source_count: entry.qualityStats.sourceCount,
          official_like_source_count: entry.qualityStats.officialLikeSourceCount,
          official_like_source_rate: entry.qualityStats.officialLikeSourceRate,
        } : {})
      });
      collapseWorkspaceProgress();
      setWorkspaceChatAvailable(true);
      activateWorkspaceView('report');
      persistCurrentWorkspaceSnapshot();
    }

    // Close the history panel
    const historyPanel = document.getElementById('historyPanel');
    if (historyPanel) {
        historyPanel.classList.remove('open');
    }

    // Scroll to the restored report if available, otherwise return to the form.
    const targetElement = reportContent
      ? document.querySelector('.report-container')
      : document.getElementById('form');
    if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth' });
    }

    // Inform user
    showToast(reportContent ? '已从历史恢复研究报告。' : '研究参数已载入，可以重新开始研究。');
  }

  // Copy entry content to clipboard
  const copyEntryToClipboard = (index) => {
    const entry = conversationHistory[index];
    if (!entry || !entry.content) return;

    const textarea = document.createElement('textarea');
    textarea.value = entry.content;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);

    // Show a toast notification
    showToast('研究内容已复制到剪贴板');
  }

  // Show a toast notification
  const showToast = (message, duration = 3000) => {
    // Create toast element if it doesn't exist
    let toast = document.getElementById('toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast-notification';
      toast.className = 'toast-notification';
      document.body.appendChild(toast);
    }

    // Set message and show
    toast.textContent = message;
    toast.classList.add('show');

    // Hide after specified duration
    setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  // Save current research to history (minimal: prompt and links only)
  const saveToHistory = async (report, downloadLinks) => {
    if (!downloadLinks) {
      console.error('No download links provided');
      showToast('错误：无法保存研究历史');
      return;
    }

    const prompt = document.getElementById('task').value;

    // Create links object with proper structure
    const links = {
      pdf: downloadLinks.pdf || '',
      docx: downloadLinks.docx || '',
      md: downloadLinks.md || '',
      json: downloadLinks.json || '',
      competitive_analysis: downloadLinks.competitive_analysis || ''
    };
    const competitiveAnalysis = downloadLinks.competitive_analysis_data || null;

    console.debug('Saving history with links:', links);

    // Create history entry with timestamp
    const timestamp = Date.now();
    const historyEntry = {
      id: getReportIdFromLinks(links) || `research-${timestamp}`,
      prompt,
      content: report || '',
      links,
      timestamp
    };

    // Add to beginning of array if it's not empty
    if (!conversationHistory) {
      conversationHistory = [];
    }

    conversationHistory.unshift(historyEntry);
    saveConversationHistory();
    renderHistoryEntries();
    document.getElementById('historyPanel').classList.add('open');

    const metadata = {
      reportType: DEFAULT_REPORT_TYPE,
      reportSource: document.querySelector('select[name="report_source"]')?.value,
      tone: DEFAULT_TONE,
      queryDomains: splitListInput(document.querySelector('input[name="query_domains"]')?.value || ''),
      competitiveResearch: getCompetitiveResearchData(),
      competitiveAnalysis,
      intermediateResults: competitiveAnalysis?.intermediate_results || null,
      competitiveMatrix: competitiveAnalysis?.competitive_matrix || null,
      qualityStats: competitiveAnalysis ? {
        sectionCompletionRate: competitiveAnalysis.section_completion_rate,
        sourceCount: competitiveAnalysis.source_count,
        officialLikeSourceCount: competitiveAnalysis.official_like_source_count,
        officialLikeSourceRate: competitiveAnalysis.official_like_source_rate,
        matrixCoverageRate: competitiveAnalysis.competitive_matrix?.coverage?.coverage_rate
      } : null
    };
    const persisted = await persistHistoryEntry(historyEntry, metadata);

    // Prompt user about storage method
    if (persisted) {
      showToast('研究已保存到后端历史，刷新后可恢复。');
    } else if (cookiesEnabled) {
      showToast('研究已保存到浏览器 Cookie。');
    } else {
      showToast('研究已保存到 localStorage。');
    }
  }

  // Function to update the research icon spinning state
  const updateResearchIcon = (isSpinning) => {
    const modernSpinner = document.getElementById('modernSpinner');
    if (modernSpinner) {
      if (isSpinning) {
        modernSpinner.classList.add('spinning');
      } else {
        modernSpinner.classList.remove('spinning');
      }
    }
  };

  const splitListInput = (value) => {
    return (value || '')
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  };

  const getCompetitiveResearchData = () => {
    const fallbackTask = document.getElementById('task').value.trim();
    const researchTopic = document.getElementById('researchTopic')?.value.trim() || fallbackTask;
    const competitors = splitListInput(document.getElementById('competitors')?.value);
    const dimensions = Array.from(document.querySelectorAll('input[name="competitive_dimension"]:checked'))
      .map((input) => input.value);
    const region = document.getElementById('region')?.value || '中国';
    const timeRange = document.getElementById('timeRange')?.value || '最近 6 个月';
    const extraRequirements = document.getElementById('extraRequirements')?.value.trim() || '';

    return {
      research_topic: researchTopic,
      competitors,
      dimensions,
      region,
      time_range: timeRange,
      extra_requirements: extraRequirements,
      original_task: fallbackTask
    };
  };

  const validateCompetitiveResearchData = (data) => {
    if (!data) {
      return true;
    }
    if (!data.research_topic) {
      showToast('请填写研究主题或任务描述');
      return false;
    }
    if (data.competitors.length < 2) {
      showToast('竞品研究模式至少需要填写 2 个竞品');
      return false;
    }
    if (data.competitors.length > 4) {
      showToast('为控制耗时和成本，首版最多支持 4 个竞品');
      return false;
    }
    if (data.dimensions.length < 1) {
      showToast('请至少选择 1 个研究维度');
      return false;
    }
    if (data.dimensions.length > 6) {
      showToast('为控制耗时和成本，首版最多支持 6 个研究维度');
      return false;
    }
    return true;
  };

  const buildCompetitiveResearchTask = (data) => {
    if (!data) {
      return document.getElementById('task').value.trim();
    }

    return `[COMPETITIVE_RESEARCH_MODE]
请进行竞品研究。请严格基于公开资料和可追溯来源生成报告，不要为了填满表格而推测未知信息。

研究主题：${data.research_topic}
竞品范围：${data.competitors.join('、')}
研究维度：${data.dimensions.join('、')}
研究地区：${data.region}
时间范围：${data.time_range}
补充要求：${data.extra_requirements || '无'}
用户原始任务：${data.original_task || data.research_topic}

来源优先级：
1. 官网、官方定价页、官方帮助中心、官方更新日志、官方公告。
2. 官方公众号、官方应用商店页面、创始人或官方团队采访。
3. 权威科技媒体、行业报告、可信第三方测评。

输出要求：
1. 按统一维度比较所有竞品。
2. 关键事实必须附来源。
3. 价格、会员权益、近期更新必须尽量标注采集时间或发布时间。
4. 找不到可靠公开信息时写“暂未找到公开信息”，不要自行补全。
5. 事实、分析和建议分开表达。
6. 输出中文竞品研究报告。`;
  };

  const startResearch = () => {
    const competitiveResearch = getCompetitiveResearchData();
    if (!validateCompetitiveResearchData(competitiveResearch)) {
      return;
    }

    document.getElementById('output').innerHTML = ''
    document.getElementById('reportContainer').innerHTML = ''
    renderCompetitiveAnalysis(null)
    dispose_socket?.() // Call previous dispose function if it exists

    // Reset report variables
    allReports = '';
    currentReport = '';
    isFirstReport = true;
    chatMessagesState = [];
    currentDownloadLinks = null;
    currentCompetitiveAnalysis = null;
    clearWorkspaceSnapshot();

    // Hide the download bar
    const stickyDownloadsBar = document.getElementById('stickyDownloadsBar');
    if (stickyDownloadsBar) {
      stickyDownloadsBar.classList.remove('visible');
    }

    // Hide the chat container
    chatContainer = document.getElementById('chatContainer');
    if (chatContainer) {
      chatContainer.style.display = 'none';
    }
    setWorkspaceChatAvailable(false);

    const imageContainer = document.getElementById('selectedImagesContainer')
    imageContainer.innerHTML = ''
    imageContainer.style.display = 'none'

    updateState('in_progress')

    addAgentResponse({
      output: '正在收集资料并分析你的研究主题...',
    })

    expandWorkspaceProgress();
    activateWorkspaceView('report');

    dispose_socket = listenToSockEvents() // Assign the new dispose function
  }

  const failActiveResearch = (message, rawMessage) => {
    if (!isResearchActive) return;
    updateState('error');
    addAgentResponse({
      type: 'logs',
      content: 'error',
      output: message,
      metadata: {
        stage: 'task_control',
        status: 'failed',
        severity: 'error',
        message_zh: message,
        raw_message: rawMessage || message,
      },
    });
  }

  const listenToSockEvents = () => {
    const { protocol, host, pathname } = window.location
    const ws_uri = `${protocol === 'https:' ? 'wss:' : 'ws:'
      }//${host}${pathname}ws`

    // Set a timeout for connection - if it takes too long, stop the spinner
    connectionTimeout = setTimeout(() => {
      updateResearchIcon(false);
      console.log("WebSocket connection timed out");
    }, 10000); // 10 seconds timeout

    // Configure Showdown converter to properly handle code blocks
    const converter = new showdown.Converter({
      ghCodeBlocks: true,         // GitHub style code blocks
      tables: true,               // Enable tables
      tasklists: true,            // Enable task lists
      smartIndentationFix: true,  // Fix weird indentation
      simpleLineBreaks: true,     // Treat newlines as <br>
      openLinksInNewWindow: true, // Open links in new tab
      parseImgDimensions: true    // Parse image dimensions from markdown
    });

    // Fix issues with code block formatting
    converter.setOption('literalMidWordUnderscores', true);

    // Increment connection attempts counter
    connectionAttempts++;

    // Update WebSocket status
    updateWebSocketStatus();

    socket = new WebSocket(ws_uri)
    let reportContent = ''; // Store the report content for history
    let downloadLinkData = null; // Store download links

    socket.onmessage = (event) => {
      // Reset reconnect attempts on successful message
      reconnectAttempts = 0;

      const data = normalizeProgressEvent(JSON.parse(event.data))
      console.log("Received message:", data);  // Debug log

      // Update WebSocket metrics
      messagesReceived++;
      lastActivityTime = Date.now();
      updateWebSocketStatus();

      if (data.type === 'logs') {
        if (data.content === 'subqueries' && data.metadata && Array.isArray(data.metadata)) {
          displaySubQuestions(data.metadata)
        }
        addAgentResponse(data)
      } else if (data.type === 'images') {
        console.log("Received images:", data);  // Debug log
        displaySelectedImages(data)
      } else if (data.type === 'report') {
        // Add to reportContent for history
        reportContent += data.output;
        currentReport = reportContent;
        writeReport({ output: data.output, type: 'report' }, converter, false, true);
      } else if (data.type === 'path') {
        updateState('finished')
        downloadLinkData = updateDownloadLink(data)
        isResearchActive = false;
        currentReport = reportContent;

        collapseWorkspaceProgress();
        setWorkspaceChatAvailable(true);
        activateWorkspaceView('report');
        persistCurrentWorkspaceSnapshot();

        // Save to history now that research is complete
        if (reportContent && downloadLinkData) {
          saveToHistory(reportContent, downloadLinkData);

          // Reset variables for next research session
          reportContent = '';
          allReports = '';
          isFirstReport = true;
        }

        // Update WebSocket status
        updateWebSocketStatus();
      } else if (data.type === 'chat') {
        // Handle chat messages from the AI
        // Remove loading indicator and add AI's response
        const loadingElements = document.querySelectorAll('.chat-loading');
        if (loadingElements.length > 0) {
          loadingElements[loadingElements.length - 1].remove();
        }

        // Add AI message to chat
        if (data.content) {
          addChatMessage(data.content, false);
          persistCurrentWorkspaceSnapshot();
        }
      }
    }

    socket.onopen = (event) => {
      // Clear the connection timeout
      clearTimeout(connectionTimeout);

      // Update WebSocket metrics
      connectionStartTime = Date.now();
      lastActivityTime = Date.now();
      updateWebSocketStatus();

      // Reset reconnect attempts on successful connection
      reconnectAttempts = 0;

      // Ensure the research icon is spinning when connection is established
      updateResearchIcon(true);

      // If this is a reconnection and we're in research mode, don't send a new start command
      if (isResearchActive && lastRequestData) {
        console.log("Reconnected during active research, not sending new start command");
        return;
      }

      const competitiveResearch = getCompetitiveResearchData();
      const task = buildCompetitiveResearchTask(competitiveResearch)
      const report_source = document.querySelector(
        'select[name="report_source"]'
      ).value
      const agent = document.querySelector('input[name="agent"]:checked').value
      let source_urls = tags

      if (report_source !== 'sources' && source_urls.length > 0) {
        source_urls = source_urls.slice(0, source_urls.length - 1)
      }

      const query_domains_str = document.querySelector('input[name="query_domains"]').value
      let query_domains = []
      if (query_domains_str) {
        query_domains = query_domains_str.split(',')
          .map((domain) => domain.trim())
          .filter((domain) => domain.length > 0);
      }

      const requestData = {
        task: task,
        report_type: DEFAULT_REPORT_TYPE,
        report_source: report_source,
        source_urls: source_urls,
        tone: DEFAULT_TONE,
        agent: agent,
        query_domains: query_domains,
        max_search_results: parseInt(document.getElementById('maxSearchResults').value, 10) || 5,
      }

      if (competitiveResearch) {
        requestData.competitive_research = competitiveResearch;
      }

      // Store the request data for potential reconnection
      lastRequestData = requestData;

      socket.send(`start ${JSON.stringify(requestData)}`)
    }

    socket.onclose = (event) => {
      // Update metrics and status when connection closes
      connectionStartTime = null;
      updateWebSocketStatus();

      console.log("WebSocket connection closed", event);

      if (isResearchActive) {
        failActiveResearch(
          '\u8fde\u63a5\u5df2\u65ad\u5f00\uff0c\u7814\u7a76\u4efb\u52a1\u5df2\u505c\u6b62\uff0c\u8bf7\u91cd\u65b0\u53d1\u8d77\u4efb\u52a1\u3002',
          `WebSocket closed: code=${event.code}, reason=${event.reason || ''}`
        );
      }
    }

    socket.onerror = (error) => {
      console.error("WebSocket error:", error);
      updateWebSocketStatus();
      failActiveResearch(
        '\u8fde\u63a5\u51fa\u9519\uff0c\u7814\u7a76\u4efb\u52a1\u5df2\u505c\u6b62\uff0c\u8bf7\u91cd\u65b0\u53d1\u8d77\u4efb\u52a1\u3002',
        'WebSocket error'
      );
    }

    // return dispose function
    return () => {
      try {
        isResearchActive = false; // Mark research as inactive
        if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
          socket.close();
        }

        // Update metrics on socket disposal
        connectionStartTime = null;
        updateWebSocketStatus();
      } catch (e) {
        console.error('Error closing socket:', e)
      }
    };
  }

  // Sanitize HTML before inserting it into the DOM. Report and agent content is
  // derived from untrusted sources (scraped web pages and LLM output), so it
  // must be sanitized to prevent cross-site scripting (XSS).
  const sanitizeHtml = (html) => {
    if (typeof DOMPurify !== 'undefined') {
      return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
    }
    // Defensive fallback if DOMPurify failed to load: escape everything.
    console.warn('DOMPurify not loaded; escaping content as a fallback.');
    const tmp = document.createElement('div');
    tmp.textContent = html;
    return tmp.innerHTML;
  };

  const normalizeProgressEvent = (data) => {
    if (!data || data.type !== 'logs') return data;

    const metadata = data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {};
    const rawMessage = metadata.raw_message || data.output || '';
    let output = metadata.message_zh || data.output || '';

    if (data.content === 'agent_evaluation') {
      const match = String(rawMessage).match(/found\s+(\d+)\s+priority gap/i);
      const count = match ? Number(match[1]) : 0;
      output = metadata.message_zh || `材料门控发现 ${count} 个优先缺口`;
      metadata.stage = metadata.stage || 'evidence_gate';
      metadata.status = metadata.status || 'completed';
      metadata.severity = metadata.severity || 'info';
    } else if (data.content === 'semantic_validation' || data.content === 'semantic_validation_summary') {
      output = metadata.message_zh || (data.content === 'semantic_validation' ? '正在校验报告语义支撑' : '语义校验完成');
      metadata.stage = metadata.stage || 'semantic_validation';
      metadata.status = metadata.status || (data.content === 'semantic_validation' ? 'running' : 'completed');
      metadata.severity = metadata.severity || 'info';
    } else if (data.content === 'semantic_remediation_summary') {
      output = metadata.message_zh || '语义补救完成';
      metadata.stage = metadata.stage || 'semantic_remediation';
      metadata.status = metadata.status || 'completed';
      metadata.severity = metadata.severity || 'info';
    } else if (data.content === 'error' || String(rawMessage).toLowerCase().startsWith('error:')) {
      output = metadata.message_zh || `任务执行失败：${String(rawMessage).replace(/^error:\s*/i, '')}`;
      metadata.stage = metadata.stage || 'system';
      metadata.status = 'failed';
      metadata.severity = 'error';
    } else if (rawMessage === 'Task already running. Please wait.') {
      output = metadata.message_zh || '任务正在运行中，请稍后再试';
      metadata.stage = metadata.stage || 'task_control';
      metadata.status = 'blocked';
      metadata.severity = 'warning';
    }

    metadata.raw_message = rawMessage;
    metadata.message_zh = output;
    metadata.stage = metadata.stage || 'research';
    metadata.status = metadata.status || 'running';
    metadata.severity = metadata.severity || 'info';
    return { ...data, output, metadata };
  };

  const addAgentResponse = (data) => {
    const output = document.getElementById('output');
    const responseDiv = document.createElement('div');
    const severity = data.metadata && data.metadata.severity ? data.metadata.severity : 'info';
    responseDiv.className = `agent_response agent_response--${severity}`;
    responseDiv.innerHTML = sanitizeHtml(data.output);
    output.appendChild(responseDiv);
    output.scrollTop = output.scrollHeight;
    output.style.display = 'block';
  }

  const renderToolCallsInProgress = (toolCalls = []) => {
    const output = document.getElementById('output');
    if (!output || !Array.isArray(toolCalls) || !toolCalls.length) return;

    const existing = document.getElementById('progressToolList');
    if (existing) existing.remove();

    const labelMap = {
      web_search: '网页检索',
      repair_search: '补充检索',
      scrape_url: '抓取网页',
      extract_evidence: '提取证据',
    };

    const section = document.createElement('div');
    section.id = 'progressToolList';
    section.className = 'progress-tool-list agent_response agent_response--info';
    section.innerHTML = `
      <strong>补充检索记录</strong>
      <ol>
        ${toolCalls.slice(0, 9).map((call) => {
          const tool = labelMap[call.tool] || call.tool || '工具步骤';
          const status = call.status === 'success' ? '已完成' : (call.status || '已记录');
          const detail = call.arguments?.query || call.reason || '';
          return `<li><span>${escapeHtml(tool)}</span>${escapeHtml(status)}：${escapeHtml(detail)}</li>`;
        }).join('')}
      </ol>
    `;
    output.appendChild(section);
    output.scrollTop = output.scrollHeight;
    output.style.display = 'block';
    workspaceProgressStarted = true;
    syncWorkspaceProgressVisibility();
  }

  const displaySubQuestions = (questions) => {
    const output = document.getElementById('output');
    const container = document.createElement('div');
    container.className = 'sub-questions';

    const heading = document.createElement('p');
    heading.className = 'sub-questions-heading';
    heading.textContent = '正在从多个角度拆解你的问题';
    container.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'sub-questions-list';
    questions.forEach((q) => {
      const pill = document.createElement('span');
      pill.className = 'sub-question-pill';
      pill.textContent = q;
      list.appendChild(pill);
    });
    container.appendChild(list);

    output.appendChild(container);
    output.scrollTop = output.scrollHeight;
    output.style.display = 'block';
  }

  const writeReport = (data, converter, isFinal = false, append = false) => {
    const reportContainer = document.getElementById('reportContainer');

    // Convert markdown to HTML, then sanitize to prevent XSS from untrusted
    // report content (scraped pages / LLM output).
    const markdownOutput = sanitizeHtml(converter.makeHtml(data.output));

    // If this is the final report or we should append
    if (isFinal) {
      // For final reports, always replace content
      reportContainer.innerHTML = markdownOutput;
    } else if (append) {
      // Append mode - add to existing content
      reportContainer.innerHTML += markdownOutput;
    } else {
      // Replace mode - overwrite existing content
      reportContainer.innerHTML = markdownOutput;
    }

    // Auto-scroll to the bottom of the container
    reportContainer.scrollTop = reportContainer.scrollHeight;
  }

  const renderCompetitiveAnalysis = (analysis) => {
    const container = document.getElementById('analysisSummaryContainer');
    if (!container) return;

    if (!analysis) {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }

    const agentTrace = analysis.agent_trace || {};
    const gapEvaluation = analysis.gap_evaluation || {};
    const repairActions = Array.isArray(analysis.repair_actions) ? analysis.repair_actions : [];
    const toolCalls = Array.isArray(agentTrace.tool_calls) ? agentTrace.tool_calls : [];
    renderToolCallsInProgress(toolCalls);
    const hardGates = Array.isArray(gapEvaluation.hard_gates) ? gapEvaluation.hard_gates : (gapEvaluation.gaps || []);
    const softWarnings = Array.isArray(gapEvaluation.soft_warnings) ? gapEvaluation.soft_warnings : [];
    const repairOutcome = analysis.repair_outcome || {};
    const resolvedGaps = Array.isArray(repairOutcome.resolved_gaps) ? repairOutcome.resolved_gaps : [];
    const unresolvedGaps = Array.isArray(repairOutcome.unresolved_gaps) ? repairOutcome.unresolved_gaps : [];
    const sourceWarnings = analysis.source_warnings || [];
    const timeScopeWarnings = analysis.time_scope_warnings || [];

    const escape = (value) => escapeHtml(String(value ?? ''));
    const gapTypeLabels = {
      unknown_official_profile: '官方主体未确认',
      missing_official_source: '缺少官方来源',
      weak_critical_evidence: '关键事实证据弱',
      missing_dimension_evidence: '维度证据缺失',
      time_scope_risk: '时效范围风险',
      time_uncertain_evidence: '日期不确定',
      source_quality_risk: '来源质量风险',
      source_quality_warning: '来源质量提示',
      candidate_official_source_found: '找到候选官方来源',
      official_source_candidate_found: '找到候选官方来源',
      low_credibility_source: '来源可信度偏低',
      insufficient_official_evidence: '官方证据不足',
      critical_fact_weak: '关键事实证据弱',
      unresolved_after_repair: '补搜后仍需核验',
      resolved_after_repair: '已补充证据'
    };
    const formatGapReasonForUser = (gap) => {
      const backendMessage = String(gap.user_message || gap.userMessage || gap.user_facing_message || '').trim();
      const suggestedAction = String(gap.suggested_action || gap.suggestedAction || '').trim();
      if (backendMessage) {
        return suggestedAction && !backendMessage.includes(suggestedAction)
          ? `${backendMessage} 建议：${suggestedAction}`
          : backendMessage;
      }
      const competitor = gap.competitor || '整体';
      const dimension = gap.dimension || '相关维度';
      const reason = String(gap.reason || '').trim();
      const type = gap.type || '';

      if (type === 'candidate_official_source_found' || type === 'official_source_candidate_found') {
        return `${competitor} 的“${dimension}”已找到疑似官方资料，但仍需要人工确认是否确实属于该产品或公司。`;
      }

      if (type === 'unknown_official_profile' || type === 'missing_official_source') {
        return `${competitor} 的“${dimension}”还缺少明确官方资料支撑，需要进一步确认官网、公告或官方账号信息。`;
      }

      if (type === 'weak_critical_evidence' || type === 'critical_fact_weak' || type === 'missing_dimension_evidence') {
        return `${competitor} 的“${dimension}”证据还不够充分，当前结论需要补充更可靠来源后再确认。`;
      }

      if (type === 'time_scope_risk' || type === 'time_uncertain_evidence') {
        return `${competitor} 的“${dimension}”信息时间不够明确，可能需要核验是否仍是最新公开情况。`;
      }

      if (type === 'source_quality_risk' || type === 'source_quality_warning' || type === 'low_credibility_source') {
        return `${competitor} 的“${dimension}”主要依据来源可信度一般，建议优先用官方或高可信媒体交叉验证。`;
      }

      return reason
        ? `${competitor} 的“${dimension}”：${reason}`
        : `${competitor} 的“${dimension}”需要进一步核验。`;
    };
    function renderGapItem(gap) {
      return `<li><span>${escape(gapTypeLabels[gap.type] || '需要核验')}</span>${escape(formatGapReasonForUser(gap))}</li>`;
    }

    const extractUrlsFromText = (text = '') => {
      const matches = String(text || '').match(/https?:\/\/[^\s)\]>"']+/g) || [];
      return matches.map((url) => url.replace(/[.,;，。；、]+$/, ''));
    };
    const normalizeUrl = (url = '') => String(url || '').trim().replace(/[?#].*$/, '').replace(/\/$/, '');
    const getReportReferencedUrls = () => {
      const reportContainer = document.getElementById('reportContainer');
      const urls = new Set(extractUrlsFromText(currentReport || reportContainer?.innerText || ''));
      reportContainer?.querySelectorAll('a[href]').forEach((link) => {
        const href = link.getAttribute('href') || '';
        if (/^https?:\/\//.test(href)) urls.add(href);
      });
      return Array.from(urls);
    };
    const reportReferencedUrls = getReportReferencedUrls();
    const reportReferencedUrlKeys = new Set(reportReferencedUrls.map(normalizeUrl));
    const sourceCandidates = [
      ...(analysis.urls || []),
      ...(analysis.intermediate_results?.source_urls || []),
      ...(analysis.evidence_ledger || []).flatMap((item) => item.urls || item.source_urls || (item.url ? [item.url] : [])),
    ].filter(Boolean);
    const officialUrlKeys = new Set((analysis.official_like_urls || []).map(normalizeUrl));
    const referencedSources = [];
    const seenSourceKeys = new Set();
    sourceCandidates.forEach((url) => {
      const key = normalizeUrl(url);
      if (!key || seenSourceKeys.has(key) || !reportReferencedUrlKeys.has(key)) return;
      seenSourceKeys.add(key);
      referencedSources.push({
        url,
        isOfficialLike: officialUrlKeys.has(key)
      });
    });
    reportReferencedUrls.forEach((url) => {
      const key = normalizeUrl(url);
      if (!key || seenSourceKeys.has(key)) return;
      seenSourceKeys.add(key);
      referencedSources.push({
        url,
        isOfficialLike: officialUrlKeys.has(key)
      });
    });
    const sourceLabel = (url) => {
      try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./, '');
      } catch (error) {
        return url;
      }
    };
    const reportText = (currentReport || document.getElementById('reportContainer')?.innerText || '').toLowerCase();
    const filterReportRelatedGaps = (gaps = []) => {
      const seen = new Set();
      return gaps.filter((gap) => {
        const key = [gap.type, gap.competitor, gap.dimension, gap.user_message || gap.reason].join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        const competitor = String(gap.competitor || '').trim().toLowerCase();
        const dimension = String(gap.dimension || '').trim().toLowerCase();
        if (competitor && !reportText.includes(competitor)) return false;
        if (dimension && !reportText.includes(dimension)) return false;
        return true;
      });
    };
    const reportRelatedGaps = filterReportRelatedGaps([
      ...unresolvedGaps,
      ...hardGates,
      ...softWarnings
    ]).slice(0, 5);
    const scopeNotes = [];
    if (timeScopeWarnings.length) {
      scopeNotes.push('报告中部分时间信息可能属于背景材料；涉及“近期更新”的结论建议以报告正文引用的发布日期为准。');
    }
    if (sourceWarnings.length && referencedSources.length) {
      scopeNotes.push('部分结论主要依赖公开网页资料；正式使用前建议优先复核报告已引用的官方或高可信来源。');
    }
    const processSummaryItems = [
      '完成公开资料搜索、抓取与报告生成',
      agentTrace.enabled ? '完成证据校验与可信度检查' : '',
      repairActions.length ? `执行 ${repairActions.length} 次补充检索` : '',
      resolvedGaps.length ? `补充确认 ${resolvedGaps.length} 条信息` : ''
    ].filter(Boolean);

    if (!referencedSources.length && !reportRelatedGaps.length && !scopeNotes.length && !processSummaryItems.length) {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }

    function renderReportEvidencePanel() {
      return `
      <div class="report-evidence-panel">
        <div class="report-evidence-header">
          <div>
            <h3>报告依据与可信度</h3>
            <p class="report-evidence-note">本模块说明正式报告生成时参考了哪些已引用资料、哪些结论仍需谨慎确认；下方“研究报告”是最终阅读版本。</p>
          </div>
          <div class="report-evidence-stats" aria-label="报告可信度概览">
            <span><strong>${escape(referencedSources.length)}</strong>引用来源</span>
            <span><strong>${escape(referencedSources.filter((source) => source.isOfficialLike).length)}</strong>官方倾向</span>
            <span><strong>${escape(reportRelatedGaps.length)}</strong>待确认</span>
          </div>
        </div>
        <div class="report-evidence-body">
          ${referencedSources.length ? `
            <div class="report-evidence-section">
              <strong>正式报告引用的来源</strong>
              <ul class="report-source-list">
                ${referencedSources.slice(0, 6).map((source) => `
                  <li>
                    <a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">${escape(sourceLabel(source.url))}</a>
                    ${source.isOfficialLike ? '<span>官方倾向</span>' : ''}
                  </li>
                `).join('')}
              </ul>
            </div>
          ` : ''}
          ${reportRelatedGaps.length ? `
            <div class="report-evidence-section agent-gap-list">
              <strong>报告中需要谨慎确认的信息</strong>
              <ul>${reportRelatedGaps.map(renderGapItem).join('')}</ul>
            </div>
          ` : ''}
          ${scopeNotes.length ? `
            <div class="report-evidence-section analysis-warnings">
              <strong>需要留意的口径</strong>
              <ul>${scopeNotes.map((note) => `<li>${escape(note)}</li>`).join('')}</ul>
            </div>
          ` : ''}
          <div class="report-evidence-section">
            <strong>生成过程概览</strong>
            <ul class="report-process-list">
              ${processSummaryItems.map((item) => `<li>${escape(item)}</li>`).join('')}
            </ul>
          </div>
        </div>
      </div>
    `;
    }
    container.innerHTML = renderReportEvidencePanel();
    container.style.display = 'block';
  }

  const updateDownloadLink = (data) => {
    if (!data.output) {
      console.error('No output data received');
      return;
    }

    const { pdf, docx, md, json, competitive_analysis } = data.output;
    const competitiveAnalysis = data.output.competitive_analysis_data || null;
    currentCompetitiveAnalysis = competitiveAnalysis;
    console.log('Received paths:', { pdf, docx, md, json, competitive_analysis });
    renderCompetitiveAnalysis(competitiveAnalysis);

    // Store these links for history
    const currentLinks = {
      pdf,
      docx,
      md,
      json,
      competitive_analysis,
      competitive_analysis_data: competitiveAnalysis
    };
    currentDownloadLinks = currentLinks;

    const disableLink = (element, reason = '该格式暂未生成') => {
      if (!element) return;
      element.removeAttribute('href');
      element.classList.add('disabled');
      element.classList.add('is-unavailable');
      element.setAttribute('onclick', 'return false;');
      element.title = reason;
    };

    const updateLink = (id, path, availableTitle) => {
      const element = document.getElementById(id);
      if (element && path) {
        console.log(`Setting ${id} href to:`, path);
        element.setAttribute('href', path);
        element.classList.remove('disabled');
        element.classList.remove('is-unavailable');
        element.removeAttribute('onclick');
        if (availableTitle) {
          element.title = availableTitle;
        }
      } else {
        disableLink(element);
        console.warn(`Either element ${id} not found or path not provided`);
      }
    };

    // Update links in sticky download bar
    updateLink('downloadLink', pdf, '下载 PDF 报告');
    updateLink('downloadLinkWord', docx, '下载 Word 文档');
    updateLink('downloadLinkMd', md, '下载 Markdown 文件');
    updateLink('downloadLinkJson', json, '下载运行日志 JSON');
    document.getElementById('downloadLink')?.classList.toggle('is-unavailable', !pdf);

    // Update duplicate report buttons above the report
    updateLink('downloadLinkTop', pdf, '下载 PDF 报告');
    updateLink('downloadLinkWordTop', docx, '下载 Word 文档');
    updateLink('downloadLinkMdTop', md, '下载 Markdown 文件');

    // Make sure download buttons are visible when download links are ready
    showDownloadPanels();

    // Return links for history saving
    return currentLinks;
  }

  const resetDownloadLinks = () => {
    const downloadButtons = document.querySelectorAll('.download-option-btn:not(#copyToClipboard), .report-action-btn');
    downloadButtons.forEach((button) => {
      button.removeAttribute('href');
      button.classList.add('disabled');
      button.classList.add('is-unavailable');
      button.setAttribute('onclick', 'return false;');
      button.title = '该格式暂未生成';
    });

    const reportActions = document.querySelector('.report-actions');
    if (reportActions) {
      reportActions.style.display = 'none';
    }
  }

  const copyToClipboard = () => {
    const textarea = document.createElement('textarea')
    textarea.id = 'temp_element'
    textarea.style.height = 0
    document.body.appendChild(textarea)
    textarea.value = document.getElementById('reportContainer').innerText
    const selector = document.querySelector('#temp_element')
    selector.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)

    // Show a temporary success message with icon change and toast notification
    const copyBtn = document.getElementById('copyToClipboard');
    const copyBtnTop = document.getElementById('copyToClipboardTop');

    // Function to reset the icon for both buttons
    const resetIcons = () => {
      if (copyBtn) {
        copyBtn.innerHTML = '<i class="fas fa-copy"></i> 复制';
      }
      if (copyBtnTop) {
        copyBtnTop.innerHTML = '<i class="fas fa-copy"></i>';
      }
    };

    // Change to green check mark
    if (copyBtn) {
      copyBtn.innerHTML = '<i class="fas fa-check" style="color: green;"></i> 已复制';
    }
    if (copyBtnTop) {
      copyBtnTop.innerHTML = '<i class="fas fa-check" style="color: green;"></i>';
    }

    // Show toast notification
    showToast('已复制到剪贴板');

    // Reset the button after 3 seconds
    setTimeout(resetIcons, 3000);
  }

  const updateState = (state) => {
    var status = ''
    switch (state) {
      case 'in_progress':
        status = '研究进行中...'
        setReportActionsStatus('disabled')
        resetDownloadLinks()
        isResearchActive = true;
        // Make the research icon spin
        updateResearchIcon(true);
        // Hide chat container during research
        chatContainer = document.getElementById('chatContainer');
        if (chatContainer) {
          chatContainer.style.display = 'none';
        }
        // Hide the copy button in the header
        const copyBtnTop = document.getElementById('copyToClipboardTop');
        if (copyBtnTop) {
          copyBtnTop.style.display = 'none';
        }
        break
      case 'finished':
        status = '研究已完成'
        isResearchActive = false;
        // Stop the research icon spinning
        updateResearchIcon(false);

        // Show download panels and hide feature panels when research is finished
        showDownloadPanels();

        // Enable the copy button
        const copyButton = document.getElementById('copyToClipboard');
        if (copyButton) {
          copyButton.classList.remove('disabled');
          copyButton.removeAttribute('onclick');
          copyButton.title = '复制报告 Markdown';
        }

        // Show copy button in the header
        const topCopyButton = document.getElementById('copyToClipboardTop');
        if (topCopyButton) {
          topCopyButton.style.display = 'inline-block';
          topCopyButton.addEventListener('click', copyToClipboard);
        }

        // Show chat container when research is finished
        chatContainer = document.getElementById('chatContainer');
        if (chatContainer) {
          chatContainer.style.display = 'flex';
          // Initialize chat if not already initialized
          initChat();
        }
        break
      case 'error':
        status = '研究失败'
        setReportActionsStatus('disabled')
        isResearchActive = false;
        // Stop the research icon spinning
        updateResearchIcon(false);
        break
      case 'initial':
        status = ''
        setReportActionsStatus('hidden')
        resetDownloadLinks()
        isResearchActive = false;
        // Make sure the research icon is not spinning initially
        updateResearchIcon(false);
        // Hide the copy button in the header
        const initialCopyBtnTop = document.getElementById('copyToClipboardTop');
        if (initialCopyBtnTop) {
          initialCopyBtnTop.style.display = 'none';
        }
        break
      default:
        setReportActionsStatus('disabled')
    }
    document.getElementById('status').innerHTML = status
    if (document.getElementById('status').innerHTML == '') {
      document.getElementById('status').style.display = 'none'
    } else {
      document.getElementById('status').style.display = 'block'
    }
  }

  /**
   * Shows or hides the download and copy buttons
   * @param {str} status Kind of hacky. Takes "enabled", "disabled", or "hidden". "Hidden is same as disabled but also hides the div"
   */
  const setReportActionsStatus = (status) => {
    const reportActions = document.getElementById('reportActions')
    // Disable everything in reportActions until research is finished

    if (status == 'enabled') {
      reportActions.querySelectorAll('a').forEach((link) => {
        link.classList.remove('disabled')
        link.removeAttribute('onclick')
        reportActions.style.display = 'block'
      })
    } else {
      reportActions.querySelectorAll('a').forEach((link) => {
        link.classList.add('disabled')
        link.setAttribute('onclick', 'return false;')
      })
      if (status == 'hidden') {
        reportActions.style.display = 'none'
      }
    }
  }

  const tagsInput = document.getElementById('tags-input');
  const input = document.getElementById('custom_source');

  const tags = [];

  const addTag = (url) => {
    if (tags.includes(url)) return;
    tags.push(url);

    const tagElement = document.createElement('span');
    tagElement.className = 'tag';
    tagElement.textContent = url;

    const removeButton = document.createElement('span');
    removeButton.className = 'remove-tag';
    removeButton.textContent = 'x';
    removeButton.onclick = function () {
      tagsInput.removeChild(tagElement);
      tags.splice(tags.indexOf(url), 1);
    };

    tagElement.appendChild(removeButton);
    tagsInput.insertBefore(tagElement, input);
  }

  const displaySelectedImages = (data) => {
    const imageContainer = document.getElementById('selectedImagesContainer')
    if (!imageContainer) return;

    imageContainer.innerHTML = ''
    imageContainer.classList.remove('has-valid-images')
    imageContainer.style.display = 'none'

    const images = JSON.parse(data.output)
    let validImageCount = 0
    console.log("Received images:", images);  // Debug log
    if (images && images.length > 0) {
      images.forEach(imageUrl => {
        const imgElement = document.createElement('img')
        imgElement.alt = '研究图片'
        imgElement.style.maxWidth = '200px'
        imgElement.style.margin = '5px'
        imgElement.style.cursor = 'pointer'
        imgElement.onclick = () => showImageDialog(imageUrl)

        imgElement.onload = () => {
          validImageCount += 1
          imageContainer.appendChild(imgElement)
          imageContainer.classList.add('has-valid-images')
          imageContainer.style.display = 'grid'
        }

        imgElement.onerror = () => {
          imgElement.remove()
          if (validImageCount === 0) {
            imageContainer.classList.remove('has-valid-images')
            imageContainer.style.display = 'none'
          }
        }

        imgElement.src = imageUrl
      })
    }
  }

  const showImageDialog = (imageUrl) => {
    let dialog = document.querySelector('.image-dialog');
    if (!dialog) {
        dialog = document.createElement('div');
        dialog.className = 'image-dialog';

        const img = document.createElement('img');
        img.alt = '研究图片大图';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '关闭';
        closeBtn.className = 'close-btn'; // Added class for styling

        dialog.appendChild(img);
        dialog.appendChild(closeBtn);
        document.body.appendChild(dialog);

        closeBtn.onclick = () => {
            dialog.classList.remove('visible');
        };
        // Close on clicking backdrop
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                dialog.classList.remove('visible');
            }
        });
    }

    const imgElement = dialog.querySelector('img');
    imgElement.src = imageUrl;
    dialog.classList.add('visible');

    // Close with Escape key
    const escapeKeyListener = (e) => {
        if (e.key === 'Escape') {
            dialog.classList.remove('visible');
            document.removeEventListener('keydown', escapeKeyListener);
        }
    };
    document.addEventListener('keydown', escapeKeyListener);
}

  // Function to show download bar and enable buttons
  const showDownloadPanels = () => {
    // Show the bar by adding the visible class
    const stickyDownloadsBar = document.getElementById('stickyDownloadsBar');
    if (stickyDownloadsBar) {
      stickyDownloadsBar.classList.add('visible');
    }

    // Make top buttons report-actions section visible
    const reportActions = document.querySelector('.report-actions');
    if (reportActions) {
      reportActions.style.display = 'flex';
    }
  }

  // --- Storage Helpers (Cookies or LocalStorage) ---
  function setCookie(name, value, days) {
    // Maximum cookie size is around 4KB (4096 bytes)
    const MAX_COOKIE_SIZE = 4000;

    // If cookies are disabled, use localStorage instead
    if (!cookiesEnabled) {
      try {
        localStorage.setItem(name, value);
        console.debug(`Data saved to localStorage: ${name}`);
        return true;
      } catch (e) {
        console.error("Error saving to localStorage:", e);
        return false;
      }
    }

    let expires = '';
    if (days) {
      const date = new Date();
      date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
      expires = '; expires=' + date.toUTCString();
    }

    // Encode the value
    const encodedValue = encodeURIComponent(value);

    // Calculate cookie size
    const cookieSize = (name + '=' + encodedValue + expires + '; path=/').length;
    console.debug(`Setting cookie: ${name}, size: ${cookieSize} bytes`);

    // If cookie is too large, display warning and truncate history
    if (cookieSize > MAX_COOKIE_SIZE) {
      console.warn(`Cookie size (${cookieSize} bytes) exceeds the ${MAX_COOKIE_SIZE} bytes limit!`);
      showToast('提醒：历史记录超过 Cookie 容量，最旧记录将被移除。');

      if (name === 'conversationHistory') {
        try {
          // Parse, reduce entries, and try again
          const historyData = JSON.parse(value);
          if (Array.isArray(historyData) && historyData.length > 1) {
            // Remove the last entry and try again recursively
            const reducedHistory = historyData.slice(0, -1);
            console.debug(`Reducing history from ${historyData.length} to ${reducedHistory.length} entries`);
            setCookie(name, JSON.stringify(reducedHistory), days);
            return; // Exit after recursive call
          }
        } catch (e) {
          console.error('Could not parse history to reduce size:', e);
        }
      }

      return false; // Indicate failure
    }

    // Set the cookie
    document.cookie = name + '=' + encodedValue + expires + '; path=/';
    console.debug(`Cookie set: ${name}`);
    return true; // Indicate success
  }

  function getCookie(name) {
    console.debug(`Getting data: ${name}`);

    // If cookies are disabled, use localStorage instead
    if (!cookiesEnabled) {
      try {
        const value = localStorage.getItem(name);
        if (value) {
          console.debug(`Data found in localStorage: ${name}, length: ${value.length} chars`);
          return value;
        }
        console.debug(`Data not found in localStorage: ${name}`);
        return null;
      } catch (e) {
        console.error("Error retrieving from localStorage:", e);
        return null;
      }
    }

    const nameEQ = name + '=';
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
      let c = ca[i];
      while (c.charAt(0) == ' ') c = c.substring(1, c.length);
      if (c.indexOf(nameEQ) == 0) {
        const value = decodeURIComponent(c.substring(nameEQ.length, c.length));
        console.debug(`Found cookie: ${name}, length: ${value.length} chars`);
        return value;
      }
    }
    console.debug(`Cookie not found: ${name}`);
    return null;
  }

  function deleteCookie(name) {
    console.debug(`Deleting storage: ${name}`);

    // If cookies are disabled, use localStorage instead
    if (!cookiesEnabled) {
      try {
        localStorage.removeItem(name);
        return;
      } catch (e) {
        console.error("Error removing from localStorage:", e);
        return;
      }
    }

    document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
  }
  // --- End Storage Helpers ---

  // Debug Helper - check cookie status
  const checkCookieStatus = () => {
    if (!cookiesEnabled) {
      const storageData = localStorage.getItem('conversationHistory');
      if (storageData) {
        const byteSize = new Blob([storageData]).size;
        const kilobyteSize = (byteSize / 1024).toFixed(2);

        try {
          const parsed = JSON.parse(storageData);
          const entryCount = Array.isArray(parsed) ? parsed.length : 0;

          showToast(`正在使用 localStorage：${kilobyteSize}KB，${entryCount} 条记录`);
          console.debug(`LocalStorage size: ${byteSize} bytes, ${kilobyteSize}KB`);
          console.debug(`LocalStorage entries: ${entryCount}`);
        } catch (e) {
          showToast(`localStorage 中的数据格式异常：${kilobyteSize}KB`);
          console.error('LocalStorage parse error:', e);
        }
      } else {
        showToast('localStorage 中没有研究历史');
      }
      return;
    }

    const allCookies = document.cookie;
    console.debug('All cookies:', allCookies);

    const conversationCookie = getCookie('conversationHistory');
    if (conversationCookie) {
      const byteSize = new Blob([conversationCookie]).size;
      const kilobyteSize = (byteSize / 1024).toFixed(2);

      try {
        const parsed = JSON.parse(conversationCookie);
        const entryCount = Array.isArray(parsed) ? parsed.length : 0;

        showToast(`已找到 Cookie：${kilobyteSize}KB，${entryCount} 条研究记录`);
        console.debug(`Cookie size: ${byteSize} bytes, ${kilobyteSize}KB`);
        console.debug(`Cookie entries: ${entryCount}`);
      } catch (e) {
        showToast(`已找到 Cookie，但数据格式异常：${kilobyteSize}KB`);
        console.error('Cookie parse error:', e);
      }
    } else {
      showToast('没有找到研究历史 Cookie');
    }
  }

  // Export history to a downloadable JSON file
  const exportHistory = () => {
    try {
      if (!conversationHistory || conversationHistory.length === 0) {
        showToast('没有可导出的研究历史');
        return;
      }

      // Create a formatted JSON string with pretty-printing
      const historyJson = JSON.stringify(conversationHistory, null, 2);

      // Create a Blob containing the data
      const blob = new Blob([historyJson], { type: 'application/json' });

      // Create an object URL for the blob
      const url = URL.createObjectURL(blob);

      // Create a temporary link element
      const link = document.createElement('a');
      link.href = url;

      // Set download attribute with filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.download = `research-history-${timestamp}.json`;

      // Append to the document
      document.body.appendChild(link);

      // Programmatically click the link to trigger the download
      link.click();

      // Clean up
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      showToast('研究历史已导出为 JSON 文件');
      console.debug('History exported, entries:', conversationHistory.length);
    } catch (error) {
      console.error('Error exporting history:', error);
      showToast('导出研究历史失败');
    }
  }

  // Trigger the file input for importing history
  const triggerImportHistory = () => {
    const fileInput = document.getElementById('historyFileInput');
    if (fileInput) {
      fileInput.click();
    } else {
      showToast('导入功能当前不可用');
    }
  }

  // Handle the file import for history
  const handleFileImport = (event) => {
    const file = event.target.files[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const content = e.target.result;
        const importedData = JSON.parse(content);

        // Validate the imported data
        if (!Array.isArray(importedData)) {
          throw new Error('导入的数据不是数组');
        }

        // Check if each entry has the required fields
        const validEntries = importedData.filter(entry => {
          return entry &&
            typeof entry === 'object' &&
            (entry.prompt || entry.task) && // Allow both prompt and legacy task field
            (entry.links || entry.downloadLinks); // Allow both links and legacy downloadLinks
        });

        if (validEntries.length === 0) {
          showToast('导入文件中没有有效的研究记录');
          return;
        }

        // Map the entries to the current structure if needed
        const mappedEntries = validEntries.map(entry => {
          return {
            prompt: entry.prompt || entry.task || '',
            links: entry.links || entry.downloadLinks || {},
            timestamp: entry.timestamp || new Date().toISOString()
          };
        });

        // Confirm before overwriting existing history
        if (conversationHistory && conversationHistory.length > 0) {
          if (confirm(`当前已有 ${conversationHistory.length} 条研究记录。请选择：
- 点击“确定”：把导入记录合并到现有历史
- 点击“取消”：用导入记录替换现有历史`)) {
            // Merge with existing history
            conversationHistory = [...mappedEntries, ...conversationHistory];
          } else {
            // Replace existing history
            conversationHistory = mappedEntries;
          }
        } else {
          // No existing history, just set the imported data
          conversationHistory = mappedEntries;
        }

        // Save the new history and update the UI
        saveConversationHistory();
        renderHistoryEntries();

        showToast(`已成功导入 ${validEntries.length} 条研究记录`);
        console.debug('Research history imported, valid entries:', validEntries.length);

      } catch (error) {
        console.error('Error importing history:', error);
        showToast('导入研究历史失败：文件格式无效');
      }

      // Reset the file input so the same file can be selected again
      event.target.value = '';
    };

    reader.onerror = () => {
      console.error('Error reading file');
      showToast('读取导入文件失败');
      event.target.value = '';
    };

    reader.readAsText(file);
  }

  // Initialize chat functionality
  const initChat = () => {
    const chatInput = document.getElementById('chatInput');
    const sendChatBtn = document.getElementById('sendChatBtn');

    if (!chatInput || !sendChatBtn) return;

    // Clear previous messages
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) {
      chatMessages.innerHTML = '';
    }
    chatMessagesState = [];

    if (chatInput.dataset.chatInitialized !== 'true') {
      // Add event listeners for chat input
      chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChatMessage();
        }
      });

      sendChatBtn.addEventListener('click', sendChatMessage);

      // Auto-resize textarea as content grows
      chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 56) + 'px';
      });

      chatInput.dataset.chatInitialized = 'true';
    }

    // Add welcome message
    addChatMessage('我可以继续回答关于这份研究报告的问题。你想进一步了解什么？', false, false);
  }

  const getCurrentChatReportContext = () => {
    if (currentReport && currentReport.trim()) {
      return currentReport.trim();
    }

    const reportContainer = document.getElementById('reportContainer');
    return reportContainer ? reportContainer.innerText.trim() : '';
  };

  const buildChatPayload = (message) => {
    const outgoingMessages = [
      ...chatMessagesState,
      { role: 'user', content: message }
    ];

    return {
      message,
      report: getCurrentChatReportContext(),
      messages: outgoingMessages
    };
  };

  // Initialize speech recognition
  const initSpeechRecognition = (button, inputElement) => {
    // Check if browser supports speech recognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      console.warn('Speech recognition not supported in this browser');
      button.style.display = 'none';
      return;
    }

    const recognition = new SpeechRecognition();

    // Configure speech recognition
    recognition.continuous = false;
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let isListening = false;
    let finalTranscript = '';

    // Add event listeners for speech recognition
    recognition.onstart = () => {
      isListening = true;
      finalTranscript = '';
      button.classList.add('listening');
      button.innerHTML = '<i class="fas fa-microphone-slash"></i>';
      button.title = '停止语音输入';

      // Show visual feedback
      showToast('正在听...', 1000);
    };

    recognition.onresult = (event) => {
      let interimTranscript = '';

      // Loop through the results
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;

        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      // Update the input element with the transcription
      inputElement.value = finalTranscript + interimTranscript;

      // Trigger input event to resize textarea
      const inputEvent = new Event('input', { bubbles: true });
      inputElement.dispatchEvent(inputEvent);
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error', event.error);
      resetRecognition();

      if (event.error === 'not-allowed') {
        showToast('麦克风权限被拒绝，请在浏览器设置中允许访问麦克风。', 3000);
      } else {
        showToast('语音识别错误：' + event.error, 3000);
      }
    };

    recognition.onend = () => {
      resetRecognition();
    };

    // Reset the recognition state
    const resetRecognition = () => {
      isListening = false;
      button.classList.remove('listening');
      button.innerHTML = '<i class="fas fa-microphone"></i>';
      button.title = '语音输入';
    };

    // Toggle speech recognition on button click
    button.addEventListener('click', () => {
      if (isListening) {
        recognition.stop();
      } else {
        recognition.start();
      }
    });
  };

  // Create a new function to handle WebSocket reconnection
  const reconnectWebSocket = (message = null) => {
    // Don't attempt too many reconnections
    if (reconnectAttempts >= maxReconnectAttempts) {
      console.error(`Failed to reconnect after ${maxReconnectAttempts} attempts`);
      addChatMessage(`重连 ${maxReconnectAttempts} 次后仍失败，请刷新页面。`, false, false);
      return false;
    }

    reconnectAttempts++;

    // Calculate backoff time (exponential backoff)
    const backoff = reconnectInterval * Math.pow(1.5, reconnectAttempts - 1);
    console.log(`Attempting to reconnect (${reconnectAttempts}/${maxReconnectAttempts}) in ${backoff}ms...`);

    // Show reconnection status to user
    addChatMessage(`连接已断开，正在尝试重连（${reconnectAttempts}/${maxReconnectAttempts}）...`, false, false);

    // Try to reconnect after delay
    setTimeout(() => {
      try {
        // Setup new WebSocket connection
        dispose_socket = listenToSockEvents();

        // Set up a one-time handler to send the message after reconnection
        if (message) {
          const messageToSend = message;
          const checkConnectionAndSend = () => {
            if (socket && socket.readyState === WebSocket.OPEN) {
              console.log("Reconnected successfully, sending queued message");
              socket.send(messageToSend);
              return true;
            } else if (reconnectAttempts < maxReconnectAttempts) {
              console.log("Socket not ready yet, retrying...");
              setTimeout(checkConnectionAndSend, 1000);
              return false;
            }
            return false;
          };

          setTimeout(checkConnectionAndSend, 1000);
        }

        return true;
      } catch (e) {
        console.error("Error during reconnection:", e);
        return false;
      }
    }, backoff);

    return true;
  };

  // Send a chat message
  const sendChatMessage = () => {
    const chatInput = document.getElementById('chatInput');
    if (!chatInput || !chatInput.value.trim()) return;

    const message = chatInput.value.trim();
    const chatPayload = buildChatPayload(message);

    // Add user message to chat
    addChatMessage(message, true);
    persistCurrentWorkspaceSnapshot();

    // Clear input
    chatInput.value = '';
    chatInput.style.height = '36px';

    // Add loading indicator
    const loadingId = addLoadingIndicator();

    // Prepare the message to send
    const messageToSend = `chat ${JSON.stringify(chatPayload)}`;

    // Send message through WebSocket
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(messageToSend);
    } else {
      // If socket is closed, try to reconnect
      removeLoadingIndicator(loadingId);

      // Reset reconnect attempts if this is a new chat session
      if (reconnectAttempts >= maxReconnectAttempts) {
        reconnectAttempts = 0;
      }

      // Attempt to reconnect and queue the message to be sent after reconnection
      if (!reconnectWebSocket(messageToSend)) {
        // If reconnection fails or max attempts reached
        addChatMessage('消息发送失败，当前连接不可用。', false, false);
      }
    }
  }

  // Add a chat message to the UI
  const addChatMessage = (message, isUser = false, track = true) => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;

    if (track && message) {
      chatMessagesState.push({
        role: isUser ? 'user' : 'assistant',
        content: message
      });
    }

    const messageEl = document.createElement('div');
    messageEl.className = `chat-message ${isUser ? 'user-message' : 'ai-message'}`;

    // Process message for AI responses (convert markdown to HTML for AI messages)
    let processedMessage = message;
    if (!isUser) {
      // Use showdown for markdown conversion
      const converter = new showdown.Converter({
        ghCodeBlocks: true,
        tables: true,
        tasklists: true,
        openLinksInNewWindow: true
      });
      processedMessage = sanitizeHtml(converter.makeHtml(message));
    }

    // Set message content
    messageEl.innerHTML = isUser ? escapeHtml(processedMessage) : processedMessage;

    // Add timestamp
    const timestampEl = document.createElement('div');
    timestampEl.className = 'chat-timestamp';
    const now = new Date();
    timestampEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    messageEl.appendChild(timestampEl);

    if (isUser) {
      chatMessages.appendChild(messageEl);
    } else {
      const messageRow = document.createElement('div');
      messageRow.className = 'chat-message-row ai-row';

      const chatAiAvatar = document.createElement('img');
      chatAiAvatar.className = 'chat-ai-avatar';
      chatAiAvatar.src = '/static/jingyan-agent-cat.png';
      chatAiAvatar.alt = '竞研 Agent';

      messageRow.appendChild(chatAiAvatar);
      messageRow.appendChild(messageEl);
      chatMessages.appendChild(messageRow);
    }

    // Scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Add a loading indicator
  const addLoadingIndicator = () => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return null;

    const loadingId = 'loading-' + Date.now();
    const loadingEl = document.createElement('div');
    loadingEl.className = 'chat-message ai-message chat-loading';
    loadingEl.id = loadingId;

    // Create the dots
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('div');
      dot.className = 'chat-dot';
      loadingEl.appendChild(dot);
    }

    chatMessages.appendChild(loadingEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    return loadingId;
  }

  // Remove loading indicator
  const removeLoadingIndicator = (loadingId) => {
    if (!loadingId) return;

    const loadingEl = document.getElementById(loadingId);
    if (loadingEl) {
      loadingEl.remove();
    }
  }

  // Escape HTML to prevent XSS in user messages
  const escapeHtml = (text) => {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Initialize expand buttons
  const initExpandButtons = () => {
    // Report container expand button
    const expandReportBtn = document.getElementById('expandReportBtn');
    if (expandReportBtn) {
      expandReportBtn.addEventListener('click', () => {
        const reportContainer = document.querySelector('.report-container');
        toggleExpand(reportContainer);
      });
    }

    // Chat container expand button
    const expandChatBtn = document.getElementById('expandChatBtn');
    if (expandChatBtn) {
      expandChatBtn.addEventListener('click', () => {
        const chatContainer = document.getElementById('chatContainer');
        toggleExpand(chatContainer);
      });
    }

    // Output container expand button
    const expandOutputBtn = document.getElementById('expandOutputBtn');
    if (expandOutputBtn) {
      expandOutputBtn.addEventListener('click', () => {
        const outputContainer = document.querySelector('.research-output-container');
        toggleExpand(outputContainer);
      });
    }

    // Close expanded view when ESC key is pressed
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const expandedElements = document.querySelectorAll('.expanded-view');
        expandedElements.forEach(el => {
          // Reset the button icon
          const button = el.querySelector('.expand-button i');
          if (button) {
            button.classList.remove('fa-compress-alt');
            button.classList.add('fa-expand-alt');
          }

          // Reset content container styles
          const contentContainers = el.querySelectorAll('#reportContainer, #output, #chatMessages');
          contentContainers.forEach(container => {
            if (container) {
              container.style.maxHeight = '';
            }
          });

          // Remove expanded-view class
          el.classList.remove('expanded-view');
        });
      }
    });
  }

  // Toggle expand mode for an element
  const toggleExpand = (element) => {
    if (!element) return;

    // Toggle expanded-view class
    element.classList.toggle('expanded-view');

    // Change button icon and title based on state
    const buttonIcon = element.querySelector('.expand-button i');
    const button = element.querySelector('.expand-button');

    if (buttonIcon && button) {
      if (element.classList.contains('expanded-view')) {
        buttonIcon.classList.remove('fa-compress-alt');
        buttonIcon.classList.add('fa-compress-alt');
        button.title = '收起'; // Update title to Collapse

        // Find content containers and expand their height
        const contentContainers = element.querySelectorAll('#reportContainer, #output, #chatMessages');
        contentContainers.forEach(container => {
          if (container) {
            // Set expanded heights - no positioning changes
            if (container.id === 'reportContainer') {
              container.style.maxHeight = '800px'; // Fixed expanded height for report
            } else {
              container.style.maxHeight = '600px'; // Fixed expanded height for other content
            }
          }
        });
      } else {
        buttonIcon.classList.remove('fa-compress-alt');
        buttonIcon.classList.add('fa-expand-alt');
        button.title = '展开'; // Update title to Expand

        // Reset heights back to original when collapsed
        const contentContainers = element.querySelectorAll('#reportContainer, #output, #chatMessages');
        contentContainers.forEach(container => {
          if (container) {
            container.style.maxHeight = '';
          }
        });
      }
    }
  }

  return {
    init,
    startResearch,
    addTag,
    copyToClipboard,
    displaySelectedImages,
    showImageDialog,
    checkCookieStatus,
    exportHistory,
    importHistory: triggerImportHistory,  // Add import function to return object
    initChat,
    sendChatMessage,
    addChatMessage
  }
})()

window.addEventListener('DOMContentLoaded', GPTResearcher.init)
