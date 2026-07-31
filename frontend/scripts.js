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
  let currentWorkbenchView = 'welcome';
  let activeHistoryIndex = null;
  let activeResearchTask = null;
  let workbenchInitialized = false;
  let chatInitialized = false;
  let restoringTaskChatHistory = false;
  let resultConversationWidth = null;
  let resultChatRequestActive = false;
  let reconnectTimer = null;
  const HISTORY_SEARCH_THRESHOLD = 8;
  const RESULT_LAYOUT_STORAGE_KEY = 'researchResultLayout:v1';
  const RESULT_CHAT_STORAGE_KEY = 'researchChatHistory:v1';
  const ACTIVE_RESEARCH_STORAGE_KEY = 'activeResearchTask:v1';

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

  const init = () => {
    restoreStoredActiveResearch();
    initWorkbench();

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

    // Initialize history panel functionality
    initHistoryPanel();

    // Initialize WebSocket monitoring panel
    initWebSocketPanel();

    // The download bar is now fixed in place with CSS
    // No need to set display property here

    if (activeResearchTask?.id && activeResearchTask.status === 'running') {
      isResearchActive = true;
      setWorkbenchView('running', { preserveUrl: true });
      updateResearchStage(activeResearchTask.stage || 'plan');
      dispose_socket = listenToSockEvents();
    } else {
      updateState('initial');
    }

    // Initialize research icon to not spinning
    updateResearchIcon(false);

    // Hide loading overlay if it exists
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
      loadingOverlay.classList.add('loading-hidden');
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

  const resolveHistoryReportContent = async (entry) => {
    if (!entry) return '';

    const storedContent = entry.content || entry.answer || '';
    if (storedContent) return storedContent;

    if (entry.id) {
      try {
        const response = await fetch(`/api/reports/${encodeURIComponent(entry.id)}`);
        if (response.ok) {
          const payload = await response.json();
          const report = payload.report || {};
          const serverContent = report.answer || report.content || '';
          if (serverContent) {
            entry.content = serverContent;
            entry.answer = serverContent;
            entry.competitiveAnalysis = entry.competitiveAnalysis || report.metadata?.competitiveAnalysis || null;
            entry.competitiveResearch = entry.competitiveResearch || report.metadata?.competitiveResearch || null;
            entry.intermediateResults = entry.intermediateResults || report.metadata?.intermediateResults || null;
            entry.competitiveMatrix = entry.competitiveMatrix || report.metadata?.competitiveMatrix || null;
            entry.qualityStats = entry.qualityStats || report.metadata?.qualityStats || null;
            entry.links = Object.keys(entry.links || {}).length > 0 ? entry.links : (report.links || {});
            return serverContent;
          }
        }
      } catch (error) {
        console.warn('Unable to fetch server report body:', error);
      }
    }

    if (entry.links?.md) {
      try {
        const response = await fetch(entry.links.md);
        if (response.ok) {
          const markdownContent = await response.text();
          if (markdownContent && markdownContent.trim()) {
            entry.content = markdownContent;
            entry.answer = markdownContent;
            return markdownContent;
          }
        }
      } catch (error) {
        console.warn('Unable to fetch markdown report from history link:', error);
      }
    }

    return '';
  }

  const resolveHistoryCompetitiveAnalysis = async (entry) => {
    if (!entry) return null;
    if (entry.competitiveAnalysis && typeof entry.competitiveAnalysis === 'object') {
      return entry.competitiveAnalysis;
    }

    const analysisPath = entry.links?.competitive_analysis;
    if (!analysisPath) return null;

    try {
      const normalizedPath = String(analysisPath).replace(/\\/g, '/');
      const requestPath = normalizedPath.startsWith('/')
        ? normalizedPath
        : `/${normalizedPath}`;
      const analysisUrl = new URL(requestPath, window.location.origin);
      if (analysisUrl.origin !== window.location.origin) return null;

      const response = await fetch(analysisUrl.toString());
      if (!response.ok) return null;

      const payload = await response.json();
      const analysis = payload?.competitive_analysis || payload?.analysis || payload;
      if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
        return null;
      }

      entry.competitiveAnalysis = analysis;
      return analysis;
    } catch (error) {
      console.warn('Unable to restore competitive source classification:', error);
      return null;
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
      const taskId = getHistoryEntryId(conversationHistory[index], index);
      conversationHistory.splice(index, 1);
      removeTaskChatHistory(taskId);
      saveConversationHistory();
      renderHistoryEntries();
      renderWorkbenchHistory();
      showToast('记录已删除');
    }
  }

  // Clear all conversation history
  const clearConversationHistory = () => {
    if (confirm('确定要清空全部研究历史吗？此操作不可撤销。')) {
      conversationHistory = [];
      clearTaskChatHistory();
      saveConversationHistory();
      renderHistoryEntries();
      renderWorkbenchHistory();
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

      // Make the card clickable, while keeping file actions independent.
      entryElement.addEventListener('click', (event) => {
        const target = event.target;
        if (target.closest('a, button')) return;
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

      entryElement.querySelectorAll('.history-entry-format a').forEach((link) => {
        link.addEventListener('click', (event) => {
          event.stopPropagation();
        });
      });

      historyEntries.appendChild(entryElement);
      setTimeout(() => {
        entryElement.style.animationDelay = `${index * 50}ms`;
      }, 0);
    });
    renderWorkbenchHistory();
  }

  // Load a research entry from history
  const loadResearchEntry = async (index) => {
    const entry = conversationHistory[index];
    if (!entry) return;

    // Fill form with the entry data
    document.getElementById('task').value = entry.prompt; // Changed from entry.task for consistency
    
    // Historical report type and tone are kept in stored metadata for compatibility,
    // but the current product flow always uses one competitive research path.
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

    // Reset UI state and report-specific buttons
    updateState('initial'); // This will hide copy buttons etc.

    showToast('正在读取历史报告...');
    const reportContent = await resolveHistoryReportContent(entry);
    if (reportContent) {
      const restoredCompetitiveAnalysis = await resolveHistoryCompetitiveAnalysis(entry);
      const analysisForHistory = restoredCompetitiveAnalysis || {
        request: entry.competitiveResearch || {},
        intermediate_results: entry.intermediateResults || {},
        competitive_matrix: entry.competitiveMatrix || {},
        ...(entry.qualityStats ? {
          section_completion_rate: entry.qualityStats.sectionCompletionRate,
          source_count: entry.qualityStats.sourceCount,
          official_like_source_count: entry.qualityStats.officialLikeSourceCount,
          official_like_source_rate: entry.qualityStats.officialLikeSourceRate,
        } : {})
      };
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
      updateDownloadLink({
        output: {
          ...(entry.links || {}),
          competitive_analysis_data: analysisForHistory
        }
      });
      const restoredTitle = entry.prompt || '调研报告';
      const resultTitle = document.getElementById('resultTaskTitle');
      const conversationTitle = document.getElementById('resultConversationTitle');
      if (resultTitle) resultTitle.textContent = restoredTitle;
      if (conversationTitle) conversationTitle.textContent = restoredTitle;
      restoreTaskChatHistory();
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
    showToast(reportContent ? '已从历史恢复研究报告。' : '这条历史只有参数，没有保存报告结果。');
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
      competitiveAnalysis,
      timestamp
    };

    // Add to beginning of array if it's not empty
    if (!conversationHistory) {
      conversationHistory = [];
    }

    conversationHistory.unshift(historyEntry);
    saveConversationHistory();
    renderHistoryEntries();
    activeResearchTask = null;
    activeHistoryIndex = 0;
    syncTaskUrl(historyEntry.id);
    renderWorkbenchHistory();
    document.getElementById('historyPanel').classList.add('open');

    const metadata = {
      reportType: 'research_report',
      reportSource: document.querySelector('select[name="report_source"]')?.value,
      tone: 'Objective',
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

    const imageContainer = document.getElementById('selectedImagesContainer')
    imageContainer.innerHTML = ''
    imageContainer.style.display = 'none'

    updateState('in_progress')

    addAgentResponse({
      output: '正在收集资料并分析你的研究主题...',
    })

    // Scroll to the "Research Progress" section
    const researchOutputContainer = document.querySelector('.research-output-container');
    if (researchOutputContainer) {
        researchOutputContainer.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
        });
    }

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

      if (data.type === 'task_accepted') {
        activeResearchTask = {
          id: data.task_id,
          prompt: data.title || activeResearchTask?.prompt || '未命名调研',
          timestamp: data.created_at || activeResearchTask?.timestamp || new Date().toISOString(),
          status: 'running',
          stage: normalizeRestoredResearchStage(data.current_stage)
        };
        isResearchActive = true;
        persistActiveResearchTask();
        syncTaskUrl(activeResearchTask.id);
        renderWorkbenchHistory();
      } else if (data.type === 'task_snapshot') {
        activeResearchTask = {
          id: data.task_id,
          prompt: data.title || activeResearchTask?.prompt || '未命名调研',
          timestamp: data.created_at || activeResearchTask?.timestamp || new Date().toISOString(),
          status: data.status || 'running',
          stage: normalizeRestoredResearchStage(data.current_stage)
        };
        if (activeResearchTask.status === 'running') {
          isResearchActive = true;
          persistActiveResearchTask();
          syncTaskUrl(activeResearchTask.id);
          setWorkbenchView('running', { preserveUrl: true });
          updateResearchStage(activeResearchTask.stage);
          renderWorkbenchHistory();
        } else if (activeResearchTask.status === 'failed') {
          clearActiveResearchTask();
          updateState('error');
        }
      } else if (data.type === 'task_not_found') {
        clearActiveResearchTask();
        isResearchActive = false;
        syncTaskUrl(null);
        setWorkbenchView('welcome', { preserveUrl: true });
        renderWorkbenchHistory();
        showToast('进行中的调研任务已失效，请重新发起。');
      } else if (data.type === 'logs') {
        const restoredStage = normalizeRestoredResearchStage(data.metadata?.stage);
        if (activeResearchTask?.id && restoredStage) {
          activeResearchTask.stage = restoredStage;
          persistActiveResearchTask();
          updateResearchStage(restoredStage);
        }
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

        writeReport({ output: data.output, type: 'report' }, converter, false, true);
      } else if (data.type === 'path') {
        updateState('finished')
        downloadLinkData = updateDownloadLink(data)
        isResearchActive = false;
        clearActiveResearchTask();

        // Save to history now that research is complete
        if (reportContent && downloadLinkData) {
          saveToHistory(reportContent, downloadLinkData);

          // Reset variables for next research session
          reportContent = '';
          allReports = '';
          currentReport = '';
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

      if (activeResearchTask?.id && activeResearchTask.status === 'running') {
        socket.send(`subscribe ${JSON.stringify({ task_id: activeResearchTask.id })}`)
        return;
      }

      const competitiveResearch = getCompetitiveResearchData();
      const task = buildCompetitiveResearchTask(competitiveResearch)
      const report_type = "research_report"
      const report_source = document.querySelector(
        'select[name="report_source"]'
      ).value
      const tone = "Objective"
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
        report_type: report_type,
        report_source: report_source,
        source_urls: source_urls,
        tone: tone,
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

      if (isResearchActive && activeResearchTask?.id) {
        showToast('连接暂时中断，后台调研仍在继续，正在恢复进度。');
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          dispose_socket = listenToSockEvents();
        }, reconnectInterval);
      }
    }

    socket.onerror = (error) => {
      console.error("WebSocket error:", error);
      updateWebSocketStatus();
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

  const normalizeReportCitationUrl = (value) => {
    try {
      const url = new URL(String(value || ''), window.location.href);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      url.hash = '';
      [
        ...url.searchParams.keys()
      ].forEach((key) => {
        const normalizedKey = key.toLowerCase();
        if (
          normalizedKey.startsWith('utm_')
          || ['fbclid', 'gclid', 'ref', 'source', 'spm'].includes(normalizedKey)
        ) {
          url.searchParams.delete(key);
        }
      });
      if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
      return url.toString();
    } catch (error) {
      return '';
    }
  };

  const normalizeReadingSourceCategory = (value) => {
    const category = String(value || '').toLowerCase();
    if (category === 's' || category === 'official') return 'official';
    if (['a', 'authoritative', 'quasi_official', 'media'].includes(category)) return 'authoritative';
    if (category === 'c' || category === 'weak_verification') return 'weak_verification';
    return 'ordinary';
  };

  const buildLegacyReadingContext = (analysis = {}) => {
    const report = document.getElementById('reportContainer');
    const citations = [...(report?.querySelectorAll('a[href]') || [])]
      .filter((link) => !link.querySelector('img') && !/\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(link.href))
      .map((link) => normalizeReportCitationUrl(link.getAttribute('href')))
      .filter(Boolean);
    const uniqueCitations = [...new Set(citations)];
    const domainMap = new Map();
    const storedClassifications = Array.isArray(analysis?.source_tiers?.classified_urls)
      ? analysis.source_tiers.classified_urls
      : [];
    const storedCategoryByUrl = new Map();
    const storedCategoryByDomain = new Map();

    storedClassifications.forEach((item) => {
      const normalizedUrl = normalizeReportCitationUrl(item?.url);
      if (!normalizedUrl) return;
      const category = normalizeReadingSourceCategory(item?.tier || item?.category);
      const domain = new URL(normalizedUrl).hostname.replace(/^www\./, '');
      storedCategoryByUrl.set(normalizedUrl, category);
      storedCategoryByDomain.set(domain, category);
    });

    uniqueCitations.forEach((url) => {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      const category = storedCategoryByUrl.get(url) || storedCategoryByDomain.get(domain) || 'ordinary';
      const existing = domainMap.get(domain) || {
        domain,
        category,
        count: 0,
        urls: []
      };
      existing.count += 1;
      existing.urls.push(url);
      domainMap.set(domain, existing);
    });
    const sourceDomains = [...domainMap.values()].sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
    const hasStoredClassifications = storedClassifications.length > 0;
    const countCategory = (category) => sourceDomains
      .filter((item) => item.category === category)
      .reduce((total, item) => total + Number(item.count || 0), 0);
    const officialCount = hasStoredClassifications ? countCategory('official') : null;
    const authoritativeCount = hasStoredClassifications ? countCategory('authoritative') : null;
    const ordinaryCount = countCategory('ordinary');
    const weakVerificationCount = hasStoredClassifications ? countCategory('weak_verification') : null;

    const selectedRange = analysis?.request?.time_range || '当前公开信息';
    const timeNote = selectedRange === '当前公开信息'
      ? '以当前可获取的公开信息为准；较早资料仅用于理解产品背景。'
      : `优先使用${selectedRange}公开信息；较早资料仅用于理解产品背景，不代表近期更新。`;

    return {
      cited_source_count: uniqueCitations.length,
      official_source_count: officialCount,
      authoritative_source_count: authoritativeCount,
      ordinary_source_count: ordinaryCount,
      weak_verification_source_count: weakVerificationCount,
      source_domains: sourceDomains,
      supported_claims: [],
      attention_items: [],
      time_scope: {
        selected_range: selectedRange,
        note: timeNote
      },
      missing_items: [],
      confidence_summary: uniqueCitations.length
        ? hasStoredClassifications
          ? '本说明根据报告正文中的实际引用及历史来源分级生成，具体结论建议结合原始页面复核。'
          : '旧报告未保留完整来源分级，以下引用按普通公开来源展示，建议结合原始页面复核。'
        : '正文暂未检测到可核验的外部引用。'
    };
  };

  const renderCompetitiveAnalysis = (analysis) => {
    const container = document.getElementById('analysisSummaryContainer');
    if (!container) return;

    if (!analysis) {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }

    const escape = (value) => escapeHtml(String(value ?? ''));
    const readingContext = analysis.reading_context || buildLegacyReadingContext(analysis);
    const citedCount = Number(readingContext.cited_source_count) || 0;
    const officialCount = readingContext.official_source_count;
    const authoritativeCount = readingContext.authoritative_source_count
      ?? readingContext.quasi_official_source_count;
    const ordinaryCount = readingContext.ordinary_source_count;
    const weakVerificationCount = readingContext.weak_verification_source_count;
    const sourceClassificationComplete = officialCount !== null
      && officialCount !== undefined
      && authoritativeCount !== null
      && authoritativeCount !== undefined
      && Number.isFinite(Number(officialCount))
      && Number.isFinite(Number(authoritativeCount));
    const officialAndAuthoritativeTotal = sourceClassificationComplete
      ? Number(officialCount) + Number(authoritativeCount)
      : null;
    const supportedClaims = Array.isArray(readingContext.supported_claims) ? readingContext.supported_claims.slice(0, 2) : [];
    const attentionItems = Array.isArray(readingContext.attention_items) ? readingContext.attention_items.slice(0, 3) : [];
    const missingItems = Array.isArray(readingContext.missing_items) ? readingContext.missing_items : [];
    const sourceDomains = (Array.isArray(readingContext.source_domains) ? readingContext.source_domains : [])
      .map((source) => ({
        ...source,
        category: normalizeReadingSourceCategory(source.category)
      }));
    const confidenceSummary = readingContext.confidence_summary
      || (citedCount
        ? '报告依据正文中实际引用的公开资料生成，建议结合原始页面理解具体结论。'
        : '正文暂未检测到可核验的外部引用。');
    const timeNote = readingContext.time_scope?.note
      || '以当前可获取的公开信息为准；较早资料仅用于理解产品背景。';
    const categoryLabels = {
      official: '官方来源',
      authoritative: '权威来源',
      ordinary: '普通公开来源',
      weak_verification: '弱验证来源'
    };
    const sumDomainCategory = (category) => sourceDomains
      .filter((source) => source.category === category)
      .reduce((total, source) => total + Number(source.count || source.urls?.length || 1), 0);
    const hasNumericCount = (value) => value !== null
      && value !== undefined
      && Number.isFinite(Number(value));
    const tierCounts = {
      official: sourceClassificationComplete ? Number(officialCount) : null,
      authoritative: sourceClassificationComplete ? Number(authoritativeCount) : null,
      ordinary: hasNumericCount(ordinaryCount) ? Number(ordinaryCount) : sumDomainCategory('ordinary'),
      weak_verification: hasNumericCount(weakVerificationCount)
        ? Number(weakVerificationCount)
        : sourceClassificationComplete
          ? sumDomainCategory('weak_verification')
          : null
    };

    const renderReadingList = (items) => (
      items.map((item) => `<li>${escape(typeof item === 'string' ? item : item?.text || item?.claim || '')}</li>`).join('')
    );

    const domainRows = sourceDomains.map((source) => {
      const urls = Array.isArray(source.urls) ? source.urls : [];
      const firstUrl = normalizeReportCitationUrl(urls[0]);
      const label = categoryLabels[source.category] || categoryLabels.ordinary;
      const domain = source.domain || (firstUrl ? new URL(firstUrl).hostname.replace(/^www\./, '') : '公开网页');
      const title = firstUrl
        ? `<a href="${escape(firstUrl)}" target="_blank" rel="noopener noreferrer">${escape(domain)}</a>`
        : `<span>${escape(domain)}</span>`;
      return `
        <li class="reading-context-domain">
          <div>${title}<small>${escape(source.count || urls.length || 1)} 条引用</small></div>
          <span class="reading-context-source-type">${escape(label)}</span>
        </li>
      `;
    }).join('');

    container.innerHTML = `
      <section class="report-reading-context" id="reportReadingContext" aria-labelledby="readingContextTitle">
        <div class="reading-context-header">
          <div>
            <span class="reading-context-eyebrow">阅读前说明</span>
            <h2 id="readingContextTitle">这份报告如何被资料支撑</h2>
          </div>
          ${citedCount ? `
            <div class="reading-context-metrics" aria-label="引用来源统计">
              <div><strong>${escape(citedCount)}</strong><span>引用来源</span></div>
              <div>
                <strong>${sourceClassificationComplete ? escape(officialAndAuthoritativeTotal) : '—'}</strong>
                <span>${sourceClassificationComplete ? '官方/权威' : '分级待复核'}</span>
              </div>
            </div>
          ` : ''}
        </div>
        <p class="reading-context-summary">${escape(confidenceSummary)}</p>
        ${attentionItems.length ? `
          <div class="reading-context-attention">
            <span>优先确认</span>
            <p>${escape(attentionItems[0])}</p>
          </div>
        ` : ''}
        <p class="reading-context-time">
          <i class="fas fa-clock" aria-hidden="true"></i>
          <span>${escape(timeNote)}</span>
        </p>
        <details class="reading-context-details" id="readingContextDetails">
          <summary aria-expanded="false">
            <span>查看详情</span>
            <i class="fas fa-chevron-down" aria-hidden="true"></i>
          </summary>
          <div class="reading-context-expanded">
            ${supportedClaims.length ? `
              <section>
                <h3>资料支撑较充分</h3>
                <ul>${renderReadingList(supportedClaims)}</ul>
              </section>
            ` : ''}
            ${attentionItems.length ? `
              <section>
                <h3>需要优先确认</h3>
                <ul>${renderReadingList(attentionItems)}</ul>
              </section>
            ` : ''}
            ${sourceDomains.length ? `
              <section>
                <h3>引用来源概览</h3>
                <div class="reading-context-tier-summary" aria-label="四档来源构成">
                  ${Object.entries(categoryLabels).map(([category, label]) => `
                    <div>
                      <strong>${tierCounts[category] === null ? '—' : escape(tierCounts[category])}</strong>
                      <span>${escape(label)}</span>
                    </div>
                  `).join('')}
                </div>
                <ul class="reading-context-domain-list">${domainRows}</ul>
              </section>
            ` : `
              <section>
                <h3>引用来源概览</h3>
                <p class="reading-context-empty">正文暂未检测到可核验的外部引用。</p>
              </section>
            `}
            ${missingItems.length ? `
              <section>
                <h3>暂未找到的公开信息</h3>
                <ul>${renderReadingList(missingItems)}</ul>
              </section>
            ` : ''}
          </div>
        </details>
      </section>
    `;
    container.style.display = 'block';
    const reportSurface = document.getElementById('researchResultHost');
    if (reportSurface) reportSurface.scrollTop = 0;
    const readingContextDetails = document.getElementById('readingContextDetails');
    readingContextDetails.addEventListener('toggle', () => {
      readingContextDetails.querySelector('summary')?.setAttribute(
        'aria-expanded',
        String(readingContextDetails.open)
      );
    });
  }

  const updateDownloadLink = (data) => {
    if (!data.output) {
      console.error('No output data received');
      return;
    }

    const { pdf, docx, md, json, competitive_analysis } = data.output;
    const competitiveAnalysis = data.output.competitive_analysis_data || null;
    const analysisForReading = competitiveAnalysis || { request: getCompetitiveResearchData() };
    console.log('Received paths:', { pdf, docx, md, json, competitive_analysis });
    renderCompetitiveAnalysis(analysisForReading);

    // Store these links for history
    const currentLinks = {
      pdf,
      docx,
      md,
      json,
      competitive_analysis,
      competitive_analysis_data: competitiveAnalysis
    };

    const disableLink = (element, reason = '该格式暂未生成') => {
      if (!element) return;
      element.removeAttribute('href');
      element.classList.add('disabled');
      element.setAttribute('onclick', 'return false;');
      element.title = reason;
    };

    const updateLink = (id, path, availableTitle) => {
      const element = document.getElementById(id);
      if (element && path) {
        console.log(`Setting ${id} href to:`, path);
        element.setAttribute('href', path);
        element.classList.remove('disabled');
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

    // Update duplicate buttons above the report
    updateLink('downloadLinkTop', pdf, '下载 PDF 报告');
    updateLink('downloadLinkWordTop', docx, '下载 Word 文档');
    updateLink('downloadLinkMdTop', md, '下载 Markdown 文件');
    updateLink('downloadLinkJsonTop', json, '下载运行日志 JSON');

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
      button.setAttribute('onclick', 'return false;');
      button.title = '该格式暂未生成';
    });

    const reportActions = document.querySelector('.report-actions');
    if (reportActions) {
      reportActions.style.display = 'none';
    }
  }

  const readLocalJson = (key, fallback) => {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (error) {
      console.warn(`Unable to read ${key} from local storage:`, error);
      return fallback;
    }
  }

  const writeLocalJson = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.warn(`Unable to write ${key} to local storage:`, error);
      return false;
    }
  }

  const normalizeRestoredResearchStage = (stage) => {
    const value = String(stage || '').toLowerCase();
    if (!value) return 'plan';
    if (/report|writing|generation/.test(value)) return 'report';
    if (/analysis|evaluation|evidence|semantic|remediation|validation/.test(value)) return 'analysis';
    if (/search|research|scrap|retriev|source/.test(value)) return 'search';
    return 'plan';
  }

  const persistActiveResearchTask = () => {
    if (!activeResearchTask?.id || activeResearchTask.status !== 'running') return;
    writeLocalJson(ACTIVE_RESEARCH_STORAGE_KEY, activeResearchTask);
  }

  const clearActiveResearchTask = () => {
    try {
      localStorage.removeItem(ACTIVE_RESEARCH_STORAGE_KEY);
    } catch (error) {
      console.warn('Unable to clear active research recovery state:', error);
    }
    activeResearchTask = null;
  }

  const restoreStoredActiveResearch = () => {
    const stored = readLocalJson(ACTIVE_RESEARCH_STORAGE_KEY, null);
    if (!stored?.id || stored.status !== 'running') return false;
    activeResearchTask = {
      id: String(stored.id),
      prompt: stored.prompt || '未命名调研',
      timestamp: stored.timestamp || new Date().toISOString(),
      status: 'running',
      stage: normalizeRestoredResearchStage(stored.stage)
    };
    isResearchActive = true;
    syncTaskUrl(activeResearchTask.id);
    return true;
  }

  const getActiveResultTaskId = () => {
    if (activeHistoryIndex !== null && conversationHistory[activeHistoryIndex]) {
      return getHistoryEntryId(conversationHistory[activeHistoryIndex], activeHistoryIndex);
    }
    if (activeResearchTask?.id) return activeResearchTask.id;
    const match = window.location.hash.match(/^#task=(.+)$/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  const getStoredTaskChats = () => readLocalJson(RESULT_CHAT_STORAGE_KEY, {});

  const persistTaskChatMessage = (message, isUser, timestamp = new Date().toISOString()) => {
    const taskId = getActiveResultTaskId();
    if (!taskId || restoringTaskChatHistory) return;
    const chats = getStoredTaskChats();
    const messages = Array.isArray(chats[taskId]) ? chats[taskId] : [];
    messages.push({
      role: isUser ? 'user' : 'assistant',
      content: String(message),
      timestamp
    });
    chats[taskId] = messages.slice(-100);
    writeLocalJson(RESULT_CHAT_STORAGE_KEY, chats);
  }

  const removeTaskChatHistory = (taskId) => {
    if (!taskId) return;
    const chats = getStoredTaskChats();
    if (!Object.prototype.hasOwnProperty.call(chats, taskId)) return;
    delete chats[taskId];
    writeLocalJson(RESULT_CHAT_STORAGE_KEY, chats);
  }

  const clearTaskChatHistory = () => {
    try {
      localStorage.removeItem(RESULT_CHAT_STORAGE_KEY);
    } catch (error) {
      console.warn('Unable to clear task chat history:', error);
    }
  }

  const restoreTaskChatHistory = () => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;
    const taskId = getActiveResultTaskId();
    const chats = getStoredTaskChats();
    const messages = taskId && Array.isArray(chats[taskId]) ? chats[taskId] : [];
    chatMessages.innerHTML = '';
    restoringTaskChatHistory = true;
    if (messages.length) {
      messages.forEach((message) => {
        addChatMessage(message.content, message.role === 'user', {
          persist: false,
          timestamp: message.timestamp
        });
      });
    } else {
      addChatMessage('我可以继续回答关于这份研究报告的问题。你想进一步了解什么？', false, {
        persist: false
      });
    }
    restoringTaskChatHistory = false;
  }

  const getResultLayoutState = () => {
    const stored = readLocalJson(RESULT_LAYOUT_STORAGE_KEY, {});
    const storedWidth = Number(stored.conversationWidth);
    return {
      sidebarCollapsed: Boolean(stored.sidebarCollapsed),
      reportCollapsed: Boolean(stored.reportCollapsed),
      mobilePane: stored.mobilePane === 'conversation' ? 'conversation' : 'report',
      conversationWidth: Number.isFinite(storedWidth) && storedWidth > 0 ? storedWidth : null
    };
  }

  const persistResultLayout = () => {
    const workbench = document.getElementById('resultWorkbench');
    writeLocalJson(RESULT_LAYOUT_STORAGE_KEY, {
      sidebarCollapsed: document.body.classList.contains('sidebar-collapsed'),
      reportCollapsed: workbench?.classList.contains('is-report-collapsed') || false,
      mobilePane: workbench?.dataset.activePane === 'conversation' ? 'conversation' : 'report',
      conversationWidth: resultConversationWidth
    });
  }

  const applyResultConversationWidth = (width, persist = true) => {
    const workbench = document.getElementById('resultWorkbench');
    const resizer = document.getElementById('resultColumnResizer');
    if (!workbench || !resizer || window.matchMedia('(max-width: 760px)').matches) return;

    const workbenchWidth = workbench.getBoundingClientRect().width || window.innerWidth;
    const minConversationWidth = 320;
    const minReportWidth = workbenchWidth < 700 ? 280 : 360;
    const maxConversationWidth = Math.max(minConversationWidth, workbenchWidth - minReportWidth - 8);
    const nextWidth = Math.min(maxConversationWidth, Math.max(minConversationWidth, Number(width) || 420));

    resultConversationWidth = Math.round(nextWidth);
    workbench.style.setProperty('--result-conversation-width', `${resultConversationWidth}px`);
    resizer.setAttribute('aria-valuemin', String(minConversationWidth));
    resizer.setAttribute('aria-valuemax', String(Math.round(maxConversationWidth)));
    resizer.setAttribute('aria-valuenow', String(resultConversationWidth));
    if (persist) persistResultLayout();
  }

  const setSidebarCollapsed = (collapsed, persist = true) => {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    const button = document.getElementById('sidebarCollapseButton');
    if (button) {
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', collapsed ? '展开任务栏' : '收起任务栏');
      button.querySelector('i')?.classList.toggle('fa-chevron-right', collapsed);
      button.querySelector('i')?.classList.toggle('fa-chevron-left', !collapsed);
    }
    if (persist) persistResultLayout();
  }

  const setReportCollapsed = (collapsed, persist = true) => {
    const workbench = document.getElementById('resultWorkbench');
    workbench?.classList.toggle('is-report-collapsed', collapsed);
    const button = document.getElementById('resultReportCollapseButton');
    if (button) {
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', collapsed ? '展开报告栏' : '收起报告栏');
    }
    if (persist) persistResultLayout();
  }

  const setResultMobilePane = (pane, persist = true) => {
    const nextPane = pane === 'conversation' ? 'conversation' : 'report';
    const workbench = document.getElementById('resultWorkbench');
    if (workbench) workbench.dataset.activePane = nextPane;
    document.querySelectorAll('[data-result-pane]').forEach((button) => {
      button.setAttribute('aria-selected', String(button.dataset.resultPane === nextPane));
    });
    if (persist) persistResultLayout();
  }

  const setResultTocOpen = (open) => {
    const toc = document.getElementById('researchToc');
    const button = document.getElementById('resultTocButton');
    if (toc) toc.hidden = !open;
    if (button) button.setAttribute('aria-expanded', String(open));
  }

  const setResultExportOpen = (open) => {
    const menu = document.getElementById('resultExportMenu');
    const button = document.getElementById('resultExportButton');
    if (menu) menu.hidden = !open;
    if (button) button.setAttribute('aria-expanded', String(open));
  }

  const setWorkbenchView = (view, options = {}) => {
    const target = document.querySelector(`[data-workbench-view="${view}"]`);
    if (!target) return;

    currentWorkbenchView = view;
    document.querySelectorAll('[data-workbench-view]').forEach((element) => {
      element.classList.toggle('is-active', element === target);
    });

    const form = document.getElementById('researchForm');
    if (form && view === 'setup-basic') {
      form.dataset.workbenchStep = 'basic';
      document.getElementById('researchFormHost')?.appendChild(form);
    }
    if (form && view === 'setup-options') {
      form.dataset.workbenchStep = 'options';
      document.getElementById('researchOptionsHost')?.appendChild(form);
      updateResearchSummary();
    }

    const titles = {
      welcome: ['竞品调研', '工作台'],
      'setup-basic': ['新建调研', '定义研究对象'],
      'setup-options': ['新建调研', '确认研究方案'],
      running: ['当前任务', '调研进行中'],
      result: ['调研结果', options.title || document.getElementById('resultTaskTitle')?.textContent || '调研报告'],
      failed: ['当前任务', '调研未完成']
    };
    const [eyebrow, title] = titles[view] || titles.welcome;
    const eyebrowNode = document.getElementById('workspaceEyebrow');
    const titleNode = document.getElementById('workspaceTitle');
    if (eyebrowNode) eyebrowNode.textContent = eyebrow;
    if (titleNode) titleNode.textContent = title;

    if (!options.preserveUrl && (view === 'welcome' || view.startsWith('setup-'))) {
      syncTaskUrl(null);
      activeHistoryIndex = null;
      renderWorkbenchHistory();
    }
    document.body.classList.remove('sidebar-open');
  }

  const syncTaskUrl = (taskId) => {
    const url = new URL(window.location.href);
    if (taskId) {
      url.hash = `task=${encodeURIComponent(taskId)}`;
    } else if (url.hash.startsWith('#task=')) {
      url.hash = '';
    }
    window.history.replaceState({ taskId: taskId || null }, '', url);
  }

  const getHistoryEntryId = (entry, index) => {
    return entry?.id || getReportIdFromLinks(entry?.links) || `history-${index}`;
  }

  const formatWorkbenchTime = (timestamp) => {
    if (!timestamp) return '时间未知';
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '时间未知';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const getHistoryGroup = (timestamp) => {
    const date = new Date(timestamp || 0);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const age = startToday - date;
    if (age <= 0 && date.getDate() === now.getDate()) return '今天';
    if (age < 7 * 86400000) return '近 7 天';
    return '更早';
  }

  const renderWorkbenchHistory = () => {
    const container = document.getElementById('workbenchHistory');
    if (!container) return;
    const query = (document.getElementById('workbenchHistorySearch')?.value || '').trim().toLowerCase();
    const entries = conversationHistory.map((entry, index) => ({
      entry,
      index,
      status: 'complete',
      id: getHistoryEntryId(entry, index)
    }));

    if (activeResearchTask && !entries.some((item) => item.id === activeResearchTask.id)) {
      entries.unshift({
        entry: activeResearchTask,
        index: -1,
        status: activeResearchTask.status || 'running',
        id: activeResearchTask.id
      });
    }
    const searchControl = document.getElementById('workbenchHistorySearch')?.closest('.sidebar-search');
    if (searchControl) {
      searchControl.hidden = entries.length < HISTORY_SEARCH_THRESHOLD;
    }

    const filtered = entries.filter(({ entry }) => {
      return !query || (entry.prompt || '').toLowerCase().includes(query);
    });
    if (!filtered.length) {
      container.innerHTML = '<p class="history-empty">还没有调研记录。<br>从一次新调研开始。</p>';
      return;
    }

    const groups = new Map([['今天', []], ['近 7 天', []], ['更早', []]]);
    filtered.forEach((item) => groups.get(getHistoryGroup(item.entry.timestamp))?.push(item));
    container.innerHTML = '';
    groups.forEach((items, label) => {
      if (!items.length) return;
      const section = document.createElement('section');
      section.className = 'workbench-history-group';
      const heading = document.createElement('strong');
      heading.textContent = label;
      section.appendChild(heading);
      items.forEach((item) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'workbench-history-item';
        if (item.index === activeHistoryIndex || item.id === activeResearchTask?.id && currentWorkbenchView === 'running') {
          button.classList.add('is-active');
        }
        button.innerHTML = `
          <span class="history-status-dot ${item.status === 'running' ? 'is-running' : item.status === 'failed' ? 'is-failed' : ''}"></span>
          <div><strong></strong><small></small></div>
        `;
        button.querySelector('strong').textContent = item.entry.prompt || '未命名调研';
        button.querySelector('small').textContent =
          `${item.status === 'running' ? '进行中' : item.status === 'failed' ? '失败' : '已完成'} · ${formatWorkbenchTime(item.entry.timestamp)}`;
        button.addEventListener('click', async () => {
          if (item.status === 'running') {
            setWorkbenchView('running', { preserveUrl: true });
            syncTaskUrl(item.id);
          } else if (item.status === 'failed') {
            setWorkbenchView('failed', { preserveUrl: true });
            syncTaskUrl(item.id);
          } else {
            activeHistoryIndex = item.index;
            syncTaskUrl(item.id);
            renderWorkbenchHistory();
            await loadResearchEntry(item.index);
          }
        });
        section.appendChild(button);
      });
      container.appendChild(section);
    });
  }

  const updateResearchSummary = () => {
    const summary = document.getElementById('researchSummary');
    if (!summary) return;
    const topic = document.getElementById('researchTopic')?.value.trim() || document.getElementById('task')?.value.trim() || '未填写';
    const competitors = document.getElementById('competitors')?.value.trim() || '未填写';
    const region = document.getElementById('region')?.selectedOptions?.[0]?.textContent || '未填写';
    summary.innerHTML = '';
    [['研究主题', topic], ['竞品范围', competitors], ['研究地区', region]].forEach(([label, value]) => {
      const item = document.createElement('div');
      const small = document.createElement('small');
      const strong = document.createElement('strong');
      small.textContent = label;
      strong.textContent = value;
      item.append(small, strong);
      summary.appendChild(item);
    });
  }

  const validateBasicSetup = () => {
    const task = document.getElementById('task');
    const topic = document.getElementById('researchTopic');
    const competitors = document.getElementById('competitors');
    [task, topic, competitors].forEach((field) => field?.classList.remove('is-invalid'));
    const hasTopic = Boolean(topic?.value.trim() || task?.value.trim());
    const hasCompetitors = Boolean(competitors?.value.trim());
    if (!hasTopic) (topic || task)?.classList.add('is-invalid');
    if (!hasCompetitors) competitors?.classList.add('is-invalid');
    if (!hasTopic || !hasCompetitors) {
      showToast('请填写研究主题和竞品名称。');
      return false;
    }
    if (!task.value.trim()) task.value = topic.value.trim();
    if (!topic.value.trim()) topic.value = task.value.trim();
    return true;
  }

  const updateResearchStage = (stage) => {
    const order = ['plan', 'search', 'analysis', 'report'];
    const currentIndex = Math.max(0, order.indexOf(stage));
    document.querySelectorAll('[data-research-stage]').forEach((item) => {
      const itemIndex = order.indexOf(item.dataset.researchStage);
      item.classList.toggle('is-complete', itemIndex < currentIndex);
      item.classList.toggle('is-active', itemIndex === currentIndex);
    });
    const copy = {
      plan: ['正在建立研究框架', 'Agent 正在读取任务并制定信息采集计划。'],
      search: ['正在搜索与采集证据', '正在获取公开信息、官方资料与可追溯来源。'],
      analysis: ['正在对比分析', '正在归纳产品差异，并对关键事实进行交叉验证。'],
      report: ['正在生成调研报告', '正在组织结论、引用与产品建议。']
    }[stage] || [];
    if (copy[0]) document.getElementById('runningTaskTitle').textContent = copy[0];
    if (copy[1]) document.getElementById('runningTaskDetail').textContent = copy[1];
  }

  const inferResearchStage = () => {
    if (currentWorkbenchView !== 'running') return;
    const output = (document.getElementById('output')?.textContent || '').toLowerCase();
    let stage = 'plan';
    if (/报告|report|撰写|write/.test(output)) stage = 'report';
    else if (/分析|对比|评估|analysis|evaluate/.test(output)) stage = 'analysis';
    else if (/搜索|检索|抓取|来源|search|scrap|source/.test(output)) stage = 'search';
    updateResearchStage(stage);
  }

  const buildReportToc = () => {
    const report = document.getElementById('reportContainer');
    const toc = document.getElementById('researchTocLinks');
    if (!report || !toc) return;
    const headings = [...report.querySelectorAll('h2, h3')];
    toc.innerHTML = '';
    headings.forEach((heading, index) => {
      if (!heading.id) heading.id = `report-section-${index + 1}`;
      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.dataset.level = heading.tagName === 'H3' ? '3' : '2';
      link.textContent = heading.textContent.trim();
      link.addEventListener('click', (event) => {
        event.preventDefault();
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setResultTocOpen(false);
      });
      toc.appendChild(link);
    });
    const tocButton = document.getElementById('resultTocButton');
    if (tocButton) tocButton.disabled = headings.length === 0;
    if (!headings.length) setResultTocOpen(false);
  }

  const restoreTaskFromUrl = async () => {
    const match = window.location.hash.match(/^#task=(.+)$/);
    if (!match) return;
    const id = decodeURIComponent(match[1]);
    if (activeResearchTask?.id === id) {
      setWorkbenchView(activeResearchTask.status === 'failed' ? 'failed' : 'running', { preserveUrl: true });
      return;
    }
    const index = conversationHistory.findIndex((entry, entryIndex) => getHistoryEntryId(entry, entryIndex) === id);
    if (index >= 0) {
      activeHistoryIndex = index;
      await loadResearchEntry(index);
    } else {
      syncTaskUrl(null);
      setWorkbenchView('welcome', { preserveUrl: true });
      showToast('未找到对应的历史任务，已返回工作台。');
    }
  }

  const initWorkbench = () => {
    if (workbenchInitialized || !document.querySelector('.research-app-shell')) return;
    workbenchInitialized = true;
    const form = document.getElementById('researchForm');
    const taskGroup = document.getElementById('task')?.closest('.form-group');
    const competitivePanel = document.querySelector('.competitive-research-panel');
    taskGroup?.classList.add('workbench-basic-field', 'workbench-step-field');
    competitivePanel?.classList.add('workbench-step-field');
    const competitiveChildren = [...(competitivePanel?.children || [])].filter((node) => node.tagName !== 'INPUT');
    competitiveChildren.forEach((node, index) => {
      node.classList.add(index === 2 ? 'workbench-options-field' : 'workbench-basic-field');
    });
    [...(form?.children || [])].forEach((node) => {
      if (node.classList?.contains('form-group') && node !== taskGroup && node !== competitivePanel) {
        node.classList.add('workbench-options-field', 'workbench-step-field');
      }
    });
    form.dataset.workbenchStep = 'basic';
    document.getElementById('researchFormHost')?.appendChild(form);

    const progressHost = document.getElementById('researchProgressHost');
    const progress = document.querySelector('.research-output-container');
    if (progressHost && progress) progressHost.appendChild(progress);
    const resultHost = document.getElementById('researchResultHost');
    const conversationHost = document.getElementById('resultConversationHost');
    const chat = document.getElementById('chatContainer');
    if (conversationHost && chat) conversationHost.appendChild(chat);
    const report = document.getElementById('reportContainer');
    const reportWrapper = report?.closest('.report-container');
    const analysisSummary = document.getElementById('analysisSummaryContainer');
    if (analysisSummary) analysisSummary.classList.add('report-reading-context-host');
    if (reportWrapper && analysisSummary) reportWrapper.prepend(analysisSummary);
    const images = document.getElementById('selectedImagesContainer')?.closest('.images_div');
    if (resultHost && images) resultHost.appendChild(images);
    if (resultHost && reportWrapper) resultHost.appendChild(reportWrapper);

    const exportHost = document.getElementById('resultExportHost');
    const reportActions = reportWrapper?.querySelector('.report-actions');
    const jsonButtonContainer = document.getElementById('jsonButtonContainer');
    if (exportHost && reportActions) exportHost.appendChild(reportActions);
    if (exportHost && jsonButtonContainer) exportHost.appendChild(jsonButtonContainer);

    const layoutState = getResultLayoutState();
    setSidebarCollapsed(layoutState.sidebarCollapsed, false);
    setReportCollapsed(layoutState.reportCollapsed, false);
    setResultMobilePane(layoutState.mobilePane, false);
    if (layoutState.conversationWidth) {
      applyResultConversationWidth(layoutState.conversationWidth, false);
    }

    document.getElementById('welcomeStartButton')?.addEventListener('click', () => setWorkbenchView('setup-basic'));
    document.getElementById('newResearchButton')?.addEventListener('click', () => setWorkbenchView('setup-basic'));
    document.getElementById('sidebarHomeButton')?.addEventListener('click', () => {
      setWorkbenchView('welcome');
      document.body.classList.remove('sidebar-open');
    });
    document.getElementById('cancelResearchSetup')?.addEventListener('click', () => setWorkbenchView('welcome'));
    document.getElementById('setupNextButton')?.addEventListener('click', () => {
      if (validateBasicSetup()) setWorkbenchView('setup-options');
    });
    document.getElementById('setupBackButton')?.addEventListener('click', () => setWorkbenchView('setup-basic'));
    document.getElementById('workbenchSubmitButton')?.addEventListener('click', () => {
      if (form?.requestSubmit) form.requestSubmit();
      else document.getElementById('submitButton')?.click();
    });

    document.querySelectorAll('[data-example-topic]').forEach((button) => {
      button.addEventListener('click', () => {
        document.getElementById('researchTopic').value = button.dataset.exampleTopic || '';
        document.getElementById('task').value = button.dataset.exampleTopic || '';
        document.getElementById('competitors').value = button.dataset.exampleCompetitors || '';
        setWorkbenchView('setup-basic');
      });
    });

    const setSidebarOpen = (open) => document.body.classList.toggle('sidebar-open', open);
    document.getElementById('mobileSidebarToggle')?.addEventListener('click', () => setSidebarOpen(true));
    document.getElementById('mobileSidebarClose')?.addEventListener('click', () => setSidebarOpen(false));
    document.getElementById('sidebarScrim')?.addEventListener('click', () => setSidebarOpen(false));
    document.getElementById('sidebarCollapseButton')?.addEventListener('click', () => {
      setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
    });
    document.getElementById('resultReportCollapseButton')?.addEventListener('click', () => setReportCollapsed(true));
    document.getElementById('resultReportRailButton')?.addEventListener('click', () => setReportCollapsed(false));
    const resultColumnResizer = document.getElementById('resultColumnResizer');
    if (resultColumnResizer) {
      let resizing = false;

      const resizeFromPointer = (event, persist = false) => {
        const workbench = document.getElementById('resultWorkbench');
        if (!workbench) return;
        applyResultConversationWidth(event.clientX - workbench.getBoundingClientRect().left, persist);
      };

      resultColumnResizer.addEventListener('pointerdown', (event) => {
        if (window.matchMedia('(max-width: 760px)').matches) return;
        resizing = true;
        document.body.classList.add('is-resizing-result');
        resultColumnResizer.setPointerCapture?.(event.pointerId);
        resizeFromPointer(event);
        event.preventDefault();
      });
      window.addEventListener('pointermove', (event) => {
        if (resizing) resizeFromPointer(event);
      });
      const finishResize = (event) => {
        if (!resizing) return;
        resizing = false;
        document.body.classList.remove('is-resizing-result');
        resizeFromPointer(event, true);
        resultColumnResizer.releasePointerCapture?.(event.pointerId);
      };
      window.addEventListener('pointerup', finishResize);
      window.addEventListener('pointercancel', finishResize);
      resultColumnResizer.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const current = Number(resultColumnResizer.getAttribute('aria-valuenow')) || resultConversationWidth || 420;
        const min = Number(resultColumnResizer.getAttribute('aria-valuemin')) || 320;
        const max = Number(resultColumnResizer.getAttribute('aria-valuemax')) || 720;
        const next = event.key === 'Home'
          ? min
          : event.key === 'End'
            ? max
            : current + (event.key === 'ArrowRight' ? 16 : -16);
        applyResultConversationWidth(next);
        event.preventDefault();
      });
      window.addEventListener('resize', () => {
        if (resultConversationWidth) applyResultConversationWidth(resultConversationWidth, false);
      });
    }
    document.querySelectorAll('[data-result-pane]').forEach((button) => {
      button.addEventListener('click', () => setResultMobilePane(button.dataset.resultPane));
    });
    document.getElementById('resultTocButton')?.addEventListener('click', () => {
      const toc = document.getElementById('researchToc');
      setResultTocOpen(Boolean(toc?.hidden));
      setResultExportOpen(false);
    });
    document.getElementById('resultTocCloseButton')?.addEventListener('click', () => setResultTocOpen(false));
    document.getElementById('resultExportButton')?.addEventListener('click', () => {
      const menu = document.getElementById('resultExportMenu');
      setResultExportOpen(Boolean(menu?.hidden));
      setResultTocOpen(false);
    });
    document.getElementById('resultCopyButton')?.addEventListener('click', copyToClipboard);
    document.getElementById('resultSourcesButton')?.addEventListener('click', () => {
      const sources = document.getElementById('reportReadingContext');
      const details = document.getElementById('readingContextDetails');
      if (sources && details) {
        details.open = true;
        sources.scrollIntoView({ behavior: 'smooth', block: 'start' });
        window.setTimeout(() => details.querySelector('summary')?.focus(), 220);
      }
      else showToast('这份报告没有返回可展示的来源明细。');
    });
    document.getElementById('workbenchHistorySearch')?.addEventListener('input', renderWorkbenchHistory);

    const historyMenu = document.getElementById('sidebarHistoryMenu');
    document.getElementById('sidebarHistoryMenuButton')?.addEventListener('click', () => {
      if (historyMenu) historyMenu.hidden = !historyMenu.hidden;
    });
    historyMenu?.addEventListener('click', (event) => {
      const action = event.target.closest('[data-history-action]')?.dataset.historyAction;
      if (action === 'export') exportHistory();
      if (action === 'import') triggerImportHistory();
      if (action === 'clear') clearConversationHistory();
      historyMenu.hidden = true;
    });

    const openStatusPanel = () => {
      document.body.classList.add('workbench-status-open');
      document.getElementById('websocketPanel')?.classList.add('open');
    };
    document.getElementById('workspaceStatusButton')?.addEventListener('click', openStatusPanel);
    document.getElementById('websocketPanelToggle')?.addEventListener('click', () => {
      document.body.classList.remove('workbench-status-open');
    });

    document.getElementById('retryResearchButton')?.addEventListener('click', () => setWorkbenchView('setup-options'));
    document.getElementById('viewFailureLogButton')?.addEventListener('click', () => {
      setWorkbenchView('running', { preserveUrl: true });
      const details = document.getElementById('researchLogDetails');
      if (details) details.open = true;
    });

    new MutationObserver(inferResearchStage).observe(document.getElementById('output'), { childList: true, subtree: true, characterData: true });
    new MutationObserver(buildReportToc).observe(document.getElementById('reportContainer'), { childList: true, subtree: true });
    window.addEventListener('hashchange', restoreTaskFromUrl);
    renderWorkbenchHistory();
    setTimeout(restoreTaskFromUrl, 900);
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
        activeResearchTask = {
          id: '',
          prompt: document.getElementById('researchTopic')?.value.trim() || document.getElementById('task')?.value.trim() || '未命名调研',
          timestamp: new Date().toISOString(),
          status: 'starting',
          stage: 'plan'
        };
        updateResearchStage('plan');
        setWorkbenchView('running', { preserveUrl: true });
        renderWorkbenchHistory();
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
        // Hide the JSON button container
        const jsonContainer = document.getElementById('jsonButtonContainer');
        if (jsonContainer) {
          jsonContainer.style.display = 'none';
        }
        break
      case 'finished':
        const finishedTitle = document.getElementById('researchTopic')?.value.trim() ||
          document.getElementById('task')?.value.trim() || activeResearchTask?.prompt || '调研报告';
        document.getElementById('resultTaskTitle').textContent = finishedTitle;
        document.getElementById('resultConversationTitle').textContent = finishedTitle;
        document.getElementById('resultTaskMeta').textContent =
          `完成于 ${new Date().toLocaleString()} · 基于公开信息生成`;
        if (activeResearchTask) activeResearchTask.status = 'complete';
        setWorkbenchView('result', { preserveUrl: true, title: finishedTitle });
        buildReportToc();
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

        // Show JSON button container
        const jsonButtonContainer = document.getElementById('jsonButtonContainer');
        if (jsonButtonContainer) {
          jsonButtonContainer.style.display = 'block';
        }

        // Show chat container when research is finished
        chatContainer = document.getElementById('chatContainer');
        if (chatContainer) {
          chatContainer.style.display = 'block';
          // Initialize chat if not already initialized
          initChat();
          restoreTaskChatHistory();
        }
        break
      case 'error':
        if (activeResearchTask) activeResearchTask.status = 'failed';
        try {
          localStorage.removeItem(ACTIVE_RESEARCH_STORAGE_KEY);
        } catch (error) {
          console.warn('Unable to clear failed research recovery state:', error);
        }
        setWorkbenchView('failed', { preserveUrl: true });
        renderWorkbenchHistory();
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
        // Hide the JSON button container
        const initialJsonContainer = document.getElementById('jsonButtonContainer');
        if (initialJsonContainer) {
          initialJsonContainer.style.display = 'none';
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
    const imageContainer = document.getElementById('selectedImagesContainer');
    let images = [];
    try {
      images = JSON.parse(data.output);
    } catch (error) {
      console.warn('Unable to parse images payload:', error);
    }

    const validUrls = Array.isArray(images)
      ? images.filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url)).slice(0, 8)
      : [];

    imageContainer.innerHTML = '';
    imageContainer.style.display = 'none';
    if (!validUrls.length) return;

    const title = document.createElement('div');
    title.className = 'reference-images-title';
    title.textContent = '参考图片';
    imageContainer.appendChild(title);

    let loadedCount = 0;
    const updateVisibility = () => {
      imageContainer.style.display = loadedCount > 0 ? 'block' : 'none';
    };

    validUrls.forEach((imageUrl) => {
      const imgElement = document.createElement('img');
      imgElement.src = imageUrl;
      imgElement.alt = '参考图片';
      imgElement.loading = 'lazy';
      imgElement.style.cursor = 'pointer';
      imgElement.onload = () => {
        loadedCount += 1;
        updateVisibility();
      };
      imgElement.onerror = () => {
        imgElement.remove();
        updateVisibility();
      };
      imgElement.onclick = () => showImageDialog(imageUrl);
      imageContainer.appendChild(imgElement);
    });
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
    if (chatInitialized) return;
    chatInitialized = true;

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
      chatInput.style.height = (chatInput.scrollHeight) + 'px';
    });

  }

  // Create a new function to handle WebSocket reconnection
  const reconnectWebSocket = (message = null) => {
    // Don't attempt too many reconnections
    if (reconnectAttempts >= maxReconnectAttempts) {
      console.error(`Failed to reconnect after ${maxReconnectAttempts} attempts`);
      addChatMessage(`重连 ${maxReconnectAttempts} 次后仍失败，请刷新页面。`, false, { persist: false });
      return false;
    }

    reconnectAttempts++;

    // Calculate backoff time (exponential backoff)
    const backoff = reconnectInterval * Math.pow(1.5, reconnectAttempts - 1);
    console.log(`Attempting to reconnect (${reconnectAttempts}/${maxReconnectAttempts}) in ${backoff}ms...`);

    // Show reconnection status to user
    addChatMessage(`连接已断开，正在尝试重连（${reconnectAttempts}/${maxReconnectAttempts}）...`, false, { persist: false });

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

  // Send a follow-up question against the currently selected report.
  const sendChatMessage = async () => {
    const chatInput = document.getElementById('chatInput');
    const sendChatBtn = document.getElementById('sendChatBtn');
    const taskId = getActiveResultTaskId();
    if (!chatInput || !chatInput.value.trim() || resultChatRequestActive) return;
    if (!taskId) {
      addChatMessage('当前没有可追问的调研报告。', false, { persist: false });
      return;
    }

    const message = chatInput.value.trim();

    addChatMessage(message, true);
    chatInput.value = '';
    chatInput.style.height = 'auto';
    const loadingId = addLoadingIndicator();
    resultChatRequestActive = true;
    if (sendChatBtn) sendChatBtn.disabled = true;

    try {
      const storedChats = getStoredTaskChats();
      const messages = (storedChats[taskId] || []).map(({ role, content }) => ({ role, content }));
      const report = currentReport || document.getElementById('reportContainer')?.innerText || '';
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report, messages })
      });
      const data = await response.json();
      if (!response.ok || data.error || !data.response?.content) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      removeLoadingIndicator(loadingId);
      addChatMessage(data.response.content, false, { timestamp: data.response.timestamp });
    } catch (error) {
      console.error('Report follow-up failed:', error);
      removeLoadingIndicator(loadingId);
      addChatMessage('追问暂时未能完成，请稍后重试。', false, { persist: false });
    } finally {
      resultChatRequestActive = false;
      if (sendChatBtn) sendChatBtn.disabled = false;
    }
  }

  // Add a chat message to the UI
  const addChatMessage = (message, isUser = false, options = {}) => {
    const chatMessages = document.getElementById('chatMessages');
    if (!chatMessages) return;

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
      processedMessage = converter.makeHtml(message);
    }

    // Set message content
    messageEl.innerHTML = isUser ? escapeHtml(processedMessage) : processedMessage;

    // Add timestamp
    const timestampEl = document.createElement('div');
    timestampEl.className = 'chat-timestamp';
    const parsedTimestamp = options.timestamp ? new Date(options.timestamp) : new Date();
    const now = Number.isNaN(parsedTimestamp.getTime()) ? new Date() : parsedTimestamp;
    timestampEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    messageEl.appendChild(timestampEl);

    // Add to chat container
    chatMessages.appendChild(messageEl);

    if (options.persist !== false) {
      persistTaskChatMessage(message, isUser, now.toISOString());
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
