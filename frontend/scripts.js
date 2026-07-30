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

    updateState('initial');

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

        writeReport({ output: data.output, type: 'report' }, converter, false, true);
      } else if (data.type === 'path') {
        updateState('finished')
        downloadLinkData = updateDownloadLink(data)
        isResearchActive = false;

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

      // If this is a reconnection and we're in research mode, don't send a new start command
      if (isResearchActive && lastRequestData) {
        console.log("Reconnected during active research, not sending new start command");
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

    const request = analysis.request || {};
    const intermediate = analysis.intermediate_results || {};
    const matrix = analysis.competitive_matrix || {};
    const coverage = matrix.coverage || {};
    const sourceTierCounts = analysis.source_tiers?.counts || {};
    const agentTrace = analysis.agent_trace || {};
    const gapEvaluation = analysis.gap_evaluation || {};
    const evidenceLedger = Array.isArray(analysis.evidence_ledger) ? analysis.evidence_ledger : [];
    const repairActions = Array.isArray(analysis.repair_actions) ? analysis.repair_actions : [];
    const toolCalls = Array.isArray(agentTrace.tool_calls) ? agentTrace.tool_calls : [];
    const evidenceDelta = agentTrace.evidence_delta || {};
    const hardGates = Array.isArray(gapEvaluation.hard_gates) ? gapEvaluation.hard_gates : (gapEvaluation.gaps || []);
    const softWarnings = Array.isArray(gapEvaluation.soft_warnings) ? gapEvaluation.soft_warnings : [];
    const evaluatorMetrics = gapEvaluation.metrics || {};
    const initialGapEvaluation = analysis.initial_gap_evaluation || {};
    const finalGapEvaluation = analysis.final_gap_evaluation || gapEvaluation;
    const repairOutcome = analysis.repair_outcome || {};
    const initialHardGates = Array.isArray(initialGapEvaluation.hard_gates) ? initialGapEvaluation.hard_gates : (initialGapEvaluation.gaps || []);
    const finalHardGates = Array.isArray(finalGapEvaluation.hard_gates) ? finalGapEvaluation.hard_gates : (finalGapEvaluation.gaps || []);
    const resolvedGaps = Array.isArray(repairOutcome.resolved_gaps) ? repairOutcome.resolved_gaps : [];
    const unresolvedGaps = Array.isArray(repairOutcome.unresolved_gaps) ? repairOutcome.unresolved_gaps : [];
    const dimensions = Array.isArray(matrix.dimensions) ? matrix.dimensions : [];
    const rows = Array.isArray(matrix.rows) ? matrix.rows : [];
    const warnings = [
      ...(analysis.source_warnings || []),
      ...(analysis.time_scope_warnings || [])
    ];

    const escape = (value) => escapeHtml(String(value ?? ''));
    const riskLabels = {
      high: '高风险',
      medium: '中风险',
      low_with_warnings: '低风险（有提示）',
      low: '低风险'
    };
    const gapTypeLabels = {
      unknown_official_profile: '官方主体未确认',
      missing_official_source: '缺少官方来源',
      weak_critical_evidence: '关键事实证据弱',
      missing_dimension_evidence: '维度证据缺失',
      time_scope_risk: '时效范围风险',
      time_uncertain_evidence: '日期不确定',
      source_quality_risk: '来源质量风险',
      source_quality_warning: '来源质量提示'
    };
    const renderGapItem = (gap) => `<li><span>${escape(gapTypeLabels[gap.type] || gap.type)}</span>${escape(gap.competitor || '整体')} / ${escape(gap.dimension || '-')}：${escape(gap.reason)}</li>`;
    const cellsHtml = rows.map((row) => `
      <tr>
        <th>${escape(row.competitor)}</th>
        ${dimensions.map((dimension) => {
          const cell = row.cells?.[dimension] || {};
          const isFound = cell.status === 'found';
          return `<td class="${isFound ? 'matrix-found' : 'matrix-missing'}">${escape(cell.summary || '暂未提取')}</td>`;
        }).join('')}
      </tr>
    `).join('');

    container.innerHTML = `
      <div class="analysis-summary-panel">
        <div class="analysis-summary-header">
          <h3>研究过程摘要</h3>
          <span>确定性后处理结果</span>
        </div>
        <div class="analysis-summary-grid">
          <div><strong>研究主题</strong><span>${escape(request.research_topic || '-')}</span></div>
          <div><strong>竞品数量</strong><span>${escape((request.competitors || []).length)}</span></div>
          <div><strong>子问题数</strong><span>${escape((intermediate.sub_queries || []).length)}</span></div>
          <div><strong>来源 URL</strong><span>${escape((intermediate.source_urls || []).length || analysis.source_count || 0)}</span></div>
          <div><strong>官方倾向来源</strong><span>${escape(analysis.official_like_source_count || 0)}</span></div>
          <div><strong>来源分级</strong><span>${escape(`S${sourceTierCounts.S || 0} / A${sourceTierCounts.A || 0} / B${sourceTierCounts.B || 0} / C${sourceTierCounts.C || 0}`)}</span></div>
          <div><strong>章节完整率</strong><span>${escape(Math.round((analysis.section_completion_rate || 0) * 100))}%</span></div>
          <div><strong>矩阵覆盖率</strong><span>${escape(Math.round((coverage.coverage_rate || 0) * 100))}%</span></div>
        </div>
        ${intermediate.sub_queries?.length ? `
          <div class="analysis-subqueries">
            <strong>Planner 生成的子问题</strong>
            <ol>${intermediate.sub_queries.slice(0, 8).map((query) => `<li>${escape(query)}</li>`).join('')}</ol>
          </div>
        ` : ''}
        ${agentTrace.enabled ? `
          <div class="agent-trace-panel">
            <div class="agent-trace-header">
              <strong>Agent 闭环过程</strong>
              <span>${escape(agentTrace.paradigm || 'plan-and-execute + evaluator-driven repair')}</span>
            </div>
            <div class="agent-trace-grid">
              <div><strong>评估风险</strong><span>${escape(gapEvaluation.overall_risk || 'low')}</span></div>
              <div><strong>优先缺口</strong><span>${escape((gapEvaluation.gaps || []).length || 0)}</span></div>
              <div><strong>补救动作</strong><span>${escape(repairActions.length)}</span></div>
              <div><strong>工具步骤</strong><span>${escape(toolCalls.length)}</span></div>
              <div><strong>证据增量</strong><span>${escape(`${evidenceDelta.before || 0} -> ${evidenceDelta.after || evidenceLedger.length || 0}`)}</span></div>
              <div><strong>补搜来源</strong><span>${escape(analysis.repaired_source_count || 0)}</span></div>
            </div>
            <div class="agent-repair-outcome">
              <strong>Repair Loop 闭环结果</strong>
              <div class="agent-trace-grid">
                <div><strong>补搜结果</strong><span>${escape(({ resolved: '已解决', partially_resolved: '部分解决', unresolved: '未解决，需人工确认', not_triggered: '未触发补搜' })[repairOutcome.status] || repairOutcome.status || '未记录')}</span></div>
                <div><strong>首次硬门槛</strong><span>${escape(initialHardGates.length)}</span></div>
                <div><strong>补搜后硬门槛</strong><span>${escape(finalHardGates.length)}</span></div>
                <div><strong>已解决缺口</strong><span>${escape(resolvedGaps.length)}</span></div>
                <div><strong>未解决缺口</strong><span>${escape(unresolvedGaps.length)}</span></div>
                <div><strong>新增证据</strong><span>${escape(repairOutcome.evidence_added ?? 0)}</span></div>
                <div><strong>补搜新增来源</strong><span>${escape(repairOutcome.repaired_source_count ?? analysis.repaired_source_count ?? 0)}</span></div>
              </div>
            </div>
            ${resolvedGaps.length ? `
              <div class="agent-gap-list agent-resolved-gap-list">
                <strong>补搜已解决缺口</strong>
                <ul>${resolvedGaps.slice(0, 5).map(renderGapItem).join('')}</ul>
              </div>
            ` : ''}
            ${unresolvedGaps.length ? `
              <div class="agent-gap-list agent-unresolved-gap-list">
                <strong>补搜后仍未解决</strong>
                <ul>${unresolvedGaps.slice(0, 5).map(renderGapItem).join('')}</ul>
              </div>
            ` : ''}
            <div class="agent-enterprise-evaluator">
              <strong>企业级 Evaluator 结果</strong>
              <div class="agent-trace-grid">
                <div><strong>风险等级</strong><span>${escape(riskLabels[gapEvaluation.overall_risk] || gapEvaluation.overall_risk || '低风险')}</span></div>
                <div><strong>硬门槛</strong><span>${escape(hardGates.length)}</span></div>
                <div><strong>软风险</strong><span>${escape(softWarnings.length)}</span></div>
                <div><strong>官方源数</strong><span>${escape(evaluatorMetrics.official_source_count ?? sourceTierCounts.S ?? 0)}</span></div>
                <div><strong>低可信占比</strong><span>${escape(Math.round((evaluatorMetrics.low_credibility_source_rate || 0) * 100))}%</span></div>
              </div>
            </div>
            ${hardGates.length ? `
              <div class="agent-gap-list">
                <strong>Evaluator 硬门槛（触发补搜）</strong>
                <ul>${hardGates.slice(0, 5).map(renderGapItem).join('')}</ul>
              </div>
            ` : ''}
            ${softWarnings.length ? `
              <div class="agent-gap-list agent-soft-warning-list">
                <strong>Evaluator 软风险（提示核验）</strong>
                <ul>${softWarnings.slice(0, 5).map(renderGapItem).join('')}</ul>
              </div>
            ` : ''}
            ${gapEvaluation.gaps?.length ? `
              <div class="agent-gap-list">
                <strong>Evaluator 发现的缺口</strong>
                <ul>${gapEvaluation.gaps.slice(0, 5).map((gap) => `<li><span>${escape(gap.type)}</span>${escape(gap.competitor || '整体')} / ${escape(gap.dimension || '-')}：${escape(gap.reason)}</li>`).join('')}</ul>
              </div>
            ` : ''}
            ${toolCalls.length ? `
              <div class="agent-tool-list">
                <strong>受控工具调用轨迹</strong>
                <ol>${toolCalls.slice(0, 9).map((call) => `<li><span>${escape(call.tool)}</span>${escape(call.status)}：${escape(call.arguments?.query || call.reason || '')}</li>`).join('')}</ol>
              </div>
            ` : ''}
          </div>
        ` : ''}
        ${warnings.length ? `
          <div class="analysis-warnings">
            <strong>后处理风险提示</strong>
            <ul>${warnings.map((warning) => `<li>${escape(warning)}</li>`).join('')}</ul>
          </div>
        ` : ''}
        ${rows.length && dimensions.length ? `
          <div class="analysis-matrix-wrap">
            <strong>基础竞品矩阵</strong>
            <table class="analysis-matrix">
              <thead>
                <tr>
                  <th>竞品</th>
                  ${dimensions.map((dimension) => `<th>${escape(dimension)}</th>`).join('')}
                </tr>
              </thead>
              <tbody>${cellsHtml}</tbody>
            </table>
          </div>
        ` : ''}
      </div>
    `;
    container.style.display = 'block';
  }

  const updateDownloadLink = (data) => {
    if (!data.output) {
      console.error('No output data received');
      return;
    }

    const { pdf, docx, md, json, competitive_analysis } = data.output;
    const competitiveAnalysis = data.output.competitive_analysis_data || null;
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
        // Hide the JSON button container
        const jsonContainer = document.getElementById('jsonButtonContainer');
        if (jsonContainer) {
          jsonContainer.style.display = 'none';
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
    const imageContainer = document.getElementById('selectedImagesContainer')
    //imageContainer.innerHTML = '<h3>Selected Images</h3>'
    const images = JSON.parse(data.output)
    console.log("Received images:", images);  // Debug log
    if (images && images.length > 0) {
      images.forEach(imageUrl => {
        const imgElement = document.createElement('img')
        imgElement.src = imageUrl
        imgElement.alt = '研究图片'
        imgElement.style.maxWidth = '200px'
        imgElement.style.margin = '5px'
        imgElement.style.cursor = 'pointer'
        imgElement.onclick = () => showImageDialog(imageUrl)
        imageContainer.appendChild(imgElement)
      })
      imageContainer.style.display = 'block'
    } else {
      imageContainer.innerHTML += '<p>本次研究未找到相关图片。</p>'
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
    const voiceInputBtn = document.getElementById('voiceInputBtn');

    if (!chatInput || !sendChatBtn) return;

    // Clear previous messages
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) {
      chatMessages.innerHTML = '';
    }

    // Add event listeners for chat input
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });

    sendChatBtn.addEventListener('click', sendChatMessage);

    // Initialize speech recognition if supported
    if (voiceInputBtn) {
      initSpeechRecognition(voiceInputBtn, chatInput);
    }

    // Auto-resize textarea as content grows
    chatInput.addEventListener('input', () => {
      chatInput.style.height = 'auto';
      chatInput.style.height = (chatInput.scrollHeight) + 'px';
    });

    // Add welcome message
    addChatMessage('我可以继续回答关于这份研究报告的问题。你想进一步了解什么？', false);
  }

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
      addChatMessage(`重连 ${maxReconnectAttempts} 次后仍失败，请刷新页面。`, false);
      return false;
    }

    reconnectAttempts++;

    // Calculate backoff time (exponential backoff)
    const backoff = reconnectInterval * Math.pow(1.5, reconnectAttempts - 1);
    console.log(`Attempting to reconnect (${reconnectAttempts}/${maxReconnectAttempts}) in ${backoff}ms...`);

    // Show reconnection status to user
    addChatMessage(`连接已断开，正在尝试重连（${reconnectAttempts}/${maxReconnectAttempts}）...`, false);

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

    // Add user message to chat
    addChatMessage(message, true);

    // Clear input
    chatInput.value = '';
    chatInput.style.height = 'auto';

    // Add loading indicator
    const loadingId = addLoadingIndicator();

    // Prepare the message to send
    const messageToSend = `chat ${JSON.stringify({ message: message })}`;

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
        addChatMessage('消息发送失败，当前连接不可用。', false);
      }
    }
  }

  // Add a chat message to the UI
  const addChatMessage = (message, isUser = false) => {
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
    const now = new Date();
    timestampEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    messageEl.appendChild(timestampEl);

    // Add to chat container
    chatMessages.appendChild(messageEl);

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
