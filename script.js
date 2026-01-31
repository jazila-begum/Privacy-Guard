// --- Global State and Utilities ---
class AppState {
    constructor() {
        this.userRole = localStorage.getItem('user_role');
        this.username = localStorage.getItem('username');
        this.sessionRedactionRules = JSON.parse(localStorage.getItem('session_redaction_rules') || '{}');
        this.sessionPermissions = JSON.parse(localStorage.getItem('session_permissions') || '{}');
        this.auditLog = JSON.parse(localStorage.getItem('audit_log') || '[]');
        this.currentDetections = [];
    }

    setUser(role, username) {
        this.userRole = role;
        this.username = username;
        localStorage.setItem('user_role', this.userRole);
        localStorage.setItem('username', this.username);
    }

    clearSession() {
        this.userRole = null;
        this.username = null;
        localStorage.clear();
    }
    
    updateRedactionRules(rules) {
        this.sessionRedactionRules = rules;
        localStorage.setItem('session_redaction_rules', JSON.stringify(rules));
    }

    updatePermissions(permissions) {
        this.sessionPermissions = permissions;
        localStorage.setItem('session_permissions', JSON.stringify(permissions));
    }
    
    addAuditEntry(field, revealedBy) {
        const entry = {
            field,
            revealedBy,
            time: new Date().toLocaleString()
        };
        this.auditLog.push(entry);
        localStorage.setItem('audit_log', JSON.stringify(this.auditLog));
    }
}

const appState = new AppState();
const elements = {};

function showToast(message, type = 'success') {
    const toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : '⚠️';
    toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-message">${message}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function showPage(pageId) {
    const pages = ['loginPage', 'dashboardPage'];
    pages.forEach(id => {
        const page = document.getElementById(id);
        if (page) {
            page.classList.toggle('hidden', id !== pageId);
        }
    });
}

function hideElement(element) {
    if (element) element.classList.add('hidden');
}

function showElement(element) {
    if (element) element.classList.remove('hidden');
}

// --- Page-Specific Logic ---

function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    
    if (!username || !password) {
        showToast('Please enter both username and password.', 'error');
        return;
    }

    let role = 'Guest';
    if (username === 'admin' && password === 'adminpass') {
        role = 'Admin';
    } else if (username === 'intern1' && password === 'internpass') {
        role = 'Intern';
    }

    appState.setUser(role, username);
    showToast(`Welcome, ${username}!`, 'success');
    updateDashboardUI();
    showPage('dashboardPage');
}

function handleLogout() {
    appState.clearSession();
    showToast('Logged out successfully.', 'success');
    showPage('loginPage');
}

function updateDashboardUI() {
    const userDisplay = document.getElementById('userDisplay');
    if (userDisplay) {
        userDisplay.textContent = `Welcome, ${appState.username} (${appState.userRole})`;
    }

    const adminSections = [elements.adminRulesSection, elements.accessManagementSection, elements.auditSection];
    if (appState.userRole === 'Admin') {
        adminSections.forEach(section => section && showElement(section));
        initializeAdminControls();
    } else {
        adminSections.forEach(section => section && hideElement(section));
    }

    initializeAccessTable();
    updateAuditTable();
}

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
        showToast('Please select a valid image file.', 'error');
        return;
    }
    
    const reader = new FileReader();
    reader.onload = function(event) {
        if (elements.originalImage && elements.redactBtn) {
            elements.originalImage.src = event.target.result;
            showElement(elements.originalPreview);
            elements.redactBtn.disabled = false;
            hideElement(elements.redactedPreview);
        }
    };
    reader.readAsDataURL(file);
}

async function handleRedact() {
    const file = elements.imageInput?.files?.[0];
    if (!file) { showToast('Please upload an image first.', 'error'); return; }
    
    elements.redactBtn.disabled = true;
    elements.redactBtn.textContent = 'Processing...';
    
    try {
        const formData = new FormData();
        formData.append('image_file', file);
        formData.append('session_redaction_rules', JSON.stringify(appState.sessionRedactionRules));
        
        const response = await fetch('/api/redact-static', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        const result = await response.json();
        if (result.error) throw new Error(result.error);
        
        elements.redactedImage.src = `data:image/jpeg;base64,${result.redacted_image}`;
        showElement(elements.redactedPreview);
        showElement(elements.downloadBtn);

        appState.currentDetections = result.detections || [];
        
        elements.redactedImage.onload = () => drawOverlayWithRevealButtons(appState.currentDetections);
        if (elements.redactedImage.complete) elements.redactedImage.onload();

        showToast(`Redaction complete! Found ${result.total_detections} PII elements.`, 'success');
        
    } catch (error) {
        console.error('Redaction error:', error);
        showToast(`Redaction failed: ${error.message}`, 'error');
    } finally {
        elements.redactBtn.disabled = false;
        elements.redactBtn.textContent = 'Redact Now';
    }
}

function drawOverlayWithRevealButtons(detections) {
    const canvas = elements.overlayCanvas;
    const ctx = canvas.getContext('2d');
    const img = elements.redactedImage;
    if (!canvas || !ctx || !img) return;

    canvas.width = img.width;
    canvas.height = img.height;
    
    document.querySelectorAll('.reveal-btn').forEach(btn => btn.remove());
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    detections.forEach(detection => {
        const [x1, y1, x2, y2] = detection.bbox;
        const piiClass = detection.class;
        
        const canView = appState.sessionPermissions[appState.userRole]?.[piiClass]?.canView !== false;
        const canReveal = appState.sessionPermissions[appState.userRole]?.[piiClass]?.canReveal !== false;
        
        if (canView) {
            ctx.strokeStyle = '#FF0000';
            ctx.lineWidth = 2;
            ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
            
            ctx.fillStyle = '#FF0000';
            ctx.font = '14px Arial';
            ctx.fillText(piiClass, x1, y1 - 5);
            
            if (canReveal) addRevealButton(detection, x1, y1, x2, y2);
        }
    });
}

function addRevealButton(detection, x1, y1, x2, y2) {
    const container = elements.redactedImage?.parentElement;
    if (!container) return;
    
    const button = document.createElement('button');
    button.textContent = '👁 Reveal';
    button.className = 'reveal-btn';
    button.style.cssText = `
        position: absolute; left: ${x2 + 5}px; top: ${y1}px;
        background: #4A90E2; color: white; border: none; border-radius: 4px;
        padding: 4px 8px; font-size: 12px; cursor: pointer; z-index: 10;
    `;
    button.onclick = () => handleReveal(detection.id, detection.class);
    container.appendChild(button);
}

async function handleReveal(detectionId, fieldName) {
    try {
        const response = await fetch(`/api/reveal/${detectionId}`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const result = await response.json();
        if (result.error) throw new Error(result.error);
        showToast(`Revealed ${fieldName}: ${result.original_value}`, 'success');
        appState.addAuditEntry(fieldName, appState.userRole);
        updateAuditTable();
    } catch (error) {
        console.error('Reveal error:', error);
        showToast(`Reveal failed: ${error.message}`, 'error');
    }
}

function handleDownload() {
    const redactedImage = document.getElementById('redactedImage');
    if (redactedImage) {
        const link = document.createElement('a');
        link.download = 'redacted_image.jpg';
        link.href = redactedImage.src;
        link.click();
    }
}

function initializeAdminControls() {
    const piiClasses = ['Name', 'Father Name', 'Date of Birth', 'Phone Number', 'Aadhaar Number'];
    piiClasses.forEach(className => {
        const toggle = elements[`toggle${className.replace(/\s+/g, '')}`];
        if (toggle) toggle.checked = appState.sessionRedactionRules[className] !== false;
    });
}

function initializeAccessTable() {
    if (!elements.accessTableBody) return;
    const roles = ['Intern', 'Guest'];
    const piiClasses = ['Name', 'Father Name', 'Date of Birth', 'Phone Number', 'Aadhaar Number'];
    elements.accessTableBody.innerHTML = '';
    roles.forEach(role => {
        piiClasses.forEach(piiClass => {
            const row = document.createElement('tr');
            const canView = appState.sessionPermissions[role]?.[piiClass]?.canView !== false;
            const canReveal = appState.sessionPermissions[role]?.[piiClass]?.canReveal !== false;
            row.innerHTML = `
                <td>${role}</td>
                <td>${piiClass}</td>
                <td><input type="checkbox" data-role="${role}" data-class="${piiClass}" data-type="view" ${canView ? 'checked' : ''}></td>
                <td><input type="checkbox" data-role="${role}" data-class="${piiClass}" data-type="reveal" ${canReveal ? 'checked' : ''} ${!canView ? 'disabled' : ''}></td>
            `;
            const canViewCheckbox = row.querySelector('[data-type="view"]');
            const canRevealCheckbox = row.querySelector('[data-type="reveal"]');
            canViewCheckbox.addEventListener('change', () => {
                canRevealCheckbox.disabled = !canViewCheckbox.checked;
                if (!canViewCheckbox.checked) canRevealCheckbox.checked = false;
            });
            elements.accessTableBody.appendChild(row);
        });
    });
}

function updateAuditTable() {
    if (!elements.auditTableBody) return;
    elements.auditTableBody.innerHTML = '';
    appState.auditLog.forEach(entry => {
        const row = document.createElement('tr');
        row.innerHTML = `<td>${entry.field}</td><td>${entry.revealedBy}</td><td>${entry.time}</td>`;
        elements.auditTableBody.appendChild(row);
    });
}

function handleApplyRules() {
    const piiClasses = ['Name', 'Father Name', 'Date of Birth', 'Phone Number', 'Aadhaar Number'];
    const rules = {};
    piiClasses.forEach(className => {
        const toggle = elements[`toggle${className.replace(/\s+/g, '')}`];
        if (toggle) rules[className] = toggle.checked;
    });
    appState.updateRedactionRules(rules);
    showToast('Session redaction rules applied successfully', 'success');
}

function handleApplyPermissions() {
    if (!elements.accessTableBody) return;
    const permissions = {};
    const rows = elements.accessTableBody.querySelectorAll('tr');
    rows.forEach(row => {
        const canViewCheckbox = row.querySelector('[data-type="view"]');
        const canRevealCheckbox = row.querySelector('[data-type="reveal"]');
        if (canViewCheckbox && canRevealCheckbox) {
            const role = canViewCheckbox.dataset.role;
            const piiClass = canViewCheckbox.dataset.class;
            if (!permissions[role]) permissions[role] = {};
            permissions[role][piiClass] = {
                canView: canViewCheckbox.checked,
                canReveal: canViewCheckbox.checked && canRevealCheckbox.checked
            };
        }
    });
    appState.updatePermissions(permissions);
    showToast('Session permissions applied successfully', 'success');
}

document.addEventListener('DOMContentLoaded', () => {
    const ids = [
        'loginPage', 'dashboardPage', 'loginForm', 'username', 'password', 'userDisplay',
        'logoutBtn', 'imageInput', 'originalPreview', 'originalImage', 'redactedPreview',
        'redactedImage', 'overlayCanvas', 'redactBtn', 'downloadBtn', 'adminRulesSection',
        'accessManagementSection', 'auditSection', 'fileUploadArea', 'toastContainer', 
        'accessTableBody', 'auditTableBody', 'applyRulesBtn', 'applyPermissionsBtn',
        'toggleName', 'toggleFatherName', 'toggleDOB', 'togglePhone', 'toggleAadhaar'
    ];
    ids.forEach(id => { elements[id] = document.getElementById(id); });

    if (appState.userRole) {
        updateDashboardUI();
        showPage('dashboardPage');
    } else {
        showPage('loginPage');
    }

    if (elements.loginForm) elements.loginForm.addEventListener('submit', handleLogin);
    if (elements.logoutBtn) elements.logoutBtn.addEventListener('click', handleLogout);
    if (elements.imageInput) elements.imageInput.addEventListener('change', handleFileSelect);
    if (elements.redactBtn) elements.redactBtn.addEventListener('click', handleRedact);
    if (elements.downloadBtn) elements.downloadBtn.addEventListener('click', handleDownload);
    
    if (elements.applyRulesBtn) elements.applyRulesBtn.addEventListener('click', handleApplyRules);
    if (elements.applyPermissionsBtn) elements.applyPermissionsBtn.addEventListener('click', handleApplyPermissions);
});