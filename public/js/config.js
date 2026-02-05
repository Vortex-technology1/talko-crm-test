// ===== GLOBAL ERROR HANDLER =====
window.onerror = function(message, source, lineno, colno, error) {
    console.error('Global error:', { message, source, lineno, colno, error });
    if (typeof logError === 'function') {
        logError('global', error || message, { source, lineno, colno });
    }
    return false;
};

window.addEventListener('unhandledrejection', function(event) {
    console.error('Unhandled promise rejection:', event.reason);
    if (typeof logError === 'function') {
        logError('promise', event.reason);
    }
});

// ===== FIREBASE CONFIG =====
const firebaseConfig = {
    apiKey: "AIzaSyCunQezswxYZyjSscD4b7Hg30YRWZ9zA-Y",
    authDomain: "talko-crm.firebaseapp.com",
    projectId: "talko-crm",
    storageBucket: "talko-crm.firebasestorage.app",
    messagingSenderId: "1090643937646",
    appId: "1:1090643937646:web:5607640c57fe9f4192597f"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// ===== SUPER ADMIN CONFIG =====
let SUPER_ADMIN_EMAILS = ['management.talco@gmail.com'];

async function loadSuperAdminConfig() {
    try {
        const configDoc = await db.collection('config').doc('superadmins').get();
        if(configDoc.exists && configDoc.data().emails) {
            SUPER_ADMIN_EMAILS = configDoc.data().emails;
            console.log('Super admin config loaded from Firestore');
        }
    } catch(e) {
        console.log('Using default super admin config');
    }
}

function isSuperAdmin(email) {
    return SUPER_ADMIN_EMAILS.includes(email?.toLowerCase());
}

// ===== BUSINESS CONSTANTS =====
const REACTIVATION_DAYS = 90;
const DEFAULT_FREEZE_MONTHS = 3;
const DEPOSIT_REMINDER_DAYS = 7;
const CONFIRM_BEFORE_DAYS = 1;
const NOSHOW_DELAYS = [7, 30, 90];
const TELEGRAM_BOT_USERNAME = 'talko_crm_bot';

// ===== APP STATE =====
let currentUser = null;
let currentOrg = null;
let currentRole = null;
let organizations = [];
let isAuthMode = 'login';
let unsubscribe = null;

// Funnel & Assignment state
let currentFunnelId = null;
let currentAssigneeFilter = null;
let selectedFunnelForEdit = null;
let teamMembers = [];
let currentSearchQuery = '';
let currentSourceFilter = null;
let currentDateFilter = null;
let selectedLeadIds = new Set();

// Data state
let leads = [];
let editing = null;
let currentFilter = 'all';
let taskFilter = 'all';

// ===== STATUS DEFAULTS =====
const ST_DEFAULT = {
    new: 'Новий лід',
    contacted: 'Контакт',
    scheduled: 'Призначена',
    completed: 'Проведена',
    report_sent: 'Звіт відправлено',
    repeat: 'Повторна',
    deposit: 'Завдаток',
    paid: 'Оплачено',
    failed: 'Відмова',
    frozen: 'Заморожений'
};

const ST = ST_DEFAULT; // Legacy compatibility

function getDefaultStatuses() {
    return {
        new: { name: 'Новий лід', color: '#1565c0', order: 1 },
        contacted: { name: 'Контакт', color: '#3949ab', order: 2 },
        scheduled: { name: 'Призначена', color: '#2e7d32', order: 3 },
        completed: { name: 'Проведена', color: '#7b1fa2', order: 4 },
        report_sent: { name: 'Звіт відправлено', color: '#00695c', order: 5 },
        deposit: { name: 'Завдаток', color: '#f57f17', order: 6 },
        paid: { name: 'Оплачено', color: '#1b5e20', order: 7, isClosed: true },
        failed: { name: 'Відмова', color: '#c62828', order: 8 },
        frozen: { name: 'Заморожений', color: '#546e7a', order: 9 }
    };
}

// ===== DEFAULT SOURCES =====
const DEFAULT_SOURCES = {
    bot: 'Бот',
    mk_clinic: 'МК Клініки',
    mk_prod: 'МК Виробництво',
    ads: 'Реклама',
    ref: 'Рекомендація',
    clinic_ua: 'Клініки UA',
    clinic_eu: 'Клініки EU',
    furniture_ua: 'Меблі UA',
    furniture_eu: 'Меблі EU',
    prod_ua: 'Виробництво UA',
    prod_metal_ua: 'Виробництво метал UA',
    prod_food_ua: 'Виробництво харчове UA',
    prod_eu: 'Виробництво EU',
    prod_eu_ru: 'Виробництво EU (RU)'
};

function getOrgSources() {
    if (currentOrg?.settings?.sources && Object.keys(currentOrg.settings.sources).length > 0) {
        return currentOrg.settings.sources;
    }
    return DEFAULT_SOURCES;
}

// Legacy SRC variable - now dynamically gets sources
const SRC = new Proxy({}, {
    get: function(target, prop) {
        const sources = getOrgSources();
        return sources[prop] || prop;
    },
    has: function(target, prop) {
        const sources = getOrgSources();
        return prop in sources;
    }
});

const CUR = { UAH: '₴', USD: '$', EUR: '€' };

// ===== FUNNEL HELPERS =====
function getOrgFunnels() {
    if (currentOrg?.settings?.funnels && currentOrg.settings.funnels.length > 0) {
        return currentOrg.settings.funnels;
    }
    if (currentOrg?.settings?.statuses && Object.keys(currentOrg.settings.statuses).length > 0) {
        return [{
            id: 'default',
            name: 'Основна воронка',
            statuses: currentOrg.settings.statuses,
            isDefault: true
        }];
    }
    return [{
        id: 'default',
        name: 'Основна воронка',
        statuses: getDefaultStatuses(),
        isDefault: true
    }];
}

function getStatusName(statusId, funnelId) {
    const funnels = getOrgFunnels();
    const funnel = funnels.find(f => f.id === (funnelId || currentFunnelId || 'default')) || funnels.find(f => f.isDefault) || funnels[0];
    const statuses = funnel?.statuses || ST_DEFAULT;
    return statuses[statusId]?.name || ST_DEFAULT[statusId] || statusId;
}

function getStatusColor(statusId, funnelId) {
    const funnels = getOrgFunnels();
    const funnel = funnels.find(f => f.id === (funnelId || currentFunnelId || 'default')) || funnels.find(f => f.isDefault) || funnels[0];
    const statuses = funnel?.statuses;
    return statuses?.[statusId]?.color || '#6b7280';
}

function getStatusIds(funnelId) {
    const funnels = getOrgFunnels();
    const funnel = funnels.find(f => f.id === (funnelId || currentFunnelId || 'default')) || funnels.find(f => f.isDefault) || funnels[0];
    const statuses = funnel?.statuses || ST_DEFAULT;
    return Object.entries(statuses).sort((a, b) => (a[1].order || 0) - (b[1].order || 0)).map(([id]) => id);
}

// ===== UTILITIES =====
function debounce(fn, delay) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), delay);
    };
}

function save() {} // deprecated - now using Firestore
function today() { return new Date().toISOString().split('T')[0]; }
function tomorrow() { let d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().split('T')[0]; }
function addDays(s, n) { if (!s) return tomorrow(); try { let d = new Date(s); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; } catch (e) { return tomorrow(); } }
function fmtDate(s) { if (!s) return '—'; try { return new Date(s).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' }); } catch (e) { return s; } }
function fmtDT(s) { if (!s) return '—'; try { return new Date(s).toLocaleString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return s; } }
function genId() { return 'l' + Date.now() + '' + Math.random().toString(36).substr(2, 5); }

// Safe date functions
function getDateOnly(dateStr) { if (!dateStr) return null; return dateStr.includes('T') ? dateStr.split('T')[0] : dateStr; }
function getTimeOnly(dateStr) { if (!dateStr || !dateStr.includes('T')) return null; return (dateStr.split('T')[1] || '').slice(0, 5) || null; }
function getConsultDate(lead) { return lead?.consult ? getDateOnly(lead.consult) : null; }
function getConsultTime(lead) { return lead?.consult ? getTimeOnly(lead.consult) : null; }
function getDayBefore(dateStr) { return addDays(getDateOnly(dateStr) || today(), -1); }

function isValidDateTime(str) {
    if (!str) return false;
    const regex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;
    if (!regex.test(str)) return false;
    const date = new Date(str);
    return !isNaN(date.getTime());
}

// ===== ESCAPE & HIGHLIGHT =====
function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightSearch(text) {
    if (text === null || text === undefined) return '';
    const escaped = escapeHtml(String(text));
    if (!currentSearchQuery) return escaped;
    const regex = new RegExp(`(${escapeRegex(currentSearchQuery)})`, 'gi');
    return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
}

// ===== DATA VALIDATION =====
function validateDate(dateStr) {
    if (!dateStr) return null;
    const dateOnly = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return null;
    const d = new Date(dateOnly);
    if (isNaN(d.getTime())) return null;
    return dateStr;
}

function validateTime(timeStr) {
    if (!timeStr) return '10:00';
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(timeStr)) return '10:00';
    return timeStr.slice(0, 5);
}

function sanitizeLead(lead) {
    const sanitized = { ...lead };
    
    sanitized.nextDate = validateDate(lead.nextDate);
    sanitized.consult = validateDate(lead.consult);
    sanitized.reactDate = validateDate(lead.reactDate);
    sanitized.finDepDate = validateDate(lead.finDepDate);
    sanitized.finPaidDate = validateDate(lead.finPaidDate);
    sanitized.confirmedDate = validateDate(lead.confirmedDate);
    
    sanitized.nextTime = validateTime(lead.nextTime);
    
    sanitized.calls = Math.max(0, parseInt(lead.calls) || 0);
    sanitized.sms = Math.max(0, parseInt(lead.sms) || 0);
    sanitized.noshow = Math.max(0, parseInt(lead.noshow) || 0);
    sanitized.repeatCount = Math.max(0, parseInt(lead.repeatCount) || 0);
    sanitized.finDep = lead.finDep ? Math.max(0, parseFloat(lead.finDep) || 0) : null;
    sanitized.finTotal = lead.finTotal ? Math.max(0, parseFloat(lead.finTotal) || 0) : null;
    
    const baseStatuses = ['new', 'contacted', 'scheduled', 'completed', 'report_sent', 'repeat', 'deposit', 'paid', 'failed', 'frozen'];
    const isCustomStatus = sanitized.status && sanitized.status.startsWith('status_');
    if (!baseStatuses.includes(sanitized.status) && !isCustomStatus) {
        sanitized.status = sanitized.status || 'new';
    }
    
    if (sanitized.notes && sanitized.notes.length > 10000) {
        sanitized.notes = sanitized.notes.slice(0, 10000);
    }
    if (sanitized.report && sanitized.report.length > 10000) {
        sanitized.report = sanitized.report.slice(0, 10000);
    }
    
    return sanitized;
}

// ===== ERROR LOGGING =====
const errorLog = [];
const MAX_ERROR_LOG = 50;

function logError(context, error, data = null) {
    const entry = {
        timestamp: new Date().toISOString(),
        context,
        message: error?.message || String(error),
        stack: error?.stack?.slice(0, 500),
        data: data ? JSON.stringify(data).slice(0, 200) : null
    };
    
    errorLog.unshift(entry);
    if (errorLog.length > MAX_ERROR_LOG) errorLog.pop();
    
    console.error(`[${context}]`, error, data);
}

function getErrorLog() {
    return errorLog;
}

// ===== TOAST NOTIFICATIONS =====
const TOAST_CONFIG = {
    success: {
        bg: '#059669',
        icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`
    },
    error: {
        bg: '#dc2626',
        icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
    },
    warning: {
        bg: '#d97706',
        icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
    },
    info: {
        bg: '#1f2937',
        icon: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`
    }
};

function showToast(message, type = 'success', duration = null) {
    const oldToast = document.querySelector('.toast-message');
    if (oldToast) oldToast.remove();
    
    const config = TOAST_CONFIG[type] || TOAST_CONFIG.info;
    const displayDuration = duration || (type === 'error' ? 5000 : 3000);
    
    const toast = document.createElement('div');
    toast.className = 'toast-message toast-' + type;
    toast.innerHTML = `${config.icon}<span>${escapeHtml(message)}</span>`;
    toast.style.cssText = `
        position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
        background:${config.bg};color:#fff;padding:12px 20px;border-radius:8px;
        font-size:14px;z-index:9999;display:flex;align-items:center;gap:10px;
        box-shadow:0 4px 12px rgba(0,0,0,0.3);animation:fadeInUp .3s ease;
        max-width:90%;text-align:left;
    `;
    document.body.appendChild(toast);
    
    setTimeout(() => {
        toast.style.animation = 'fadeOutDown .3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, displayDuration);
}

function showError(message) { showToast(message, 'error'); }
function showWarning(message) { showToast(message, 'warning'); }
function showInfo(message) { showToast(message, 'info'); }

// ===== LOADING OVERLAY =====
function showLoading(text = 'Завантаження...') {
    const el = document.getElementById('loading-overlay');
    if (el) {
        el.querySelector('div:last-child').textContent = text;
        el.style.display = 'flex';
    }
}

function hideLoading() {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
}

function setSyncStatus(status, text) {
    const dot = document.getElementById('sync-dot');
    const txt = document.getElementById('sync-text');
    if (dot) dot.className = 'sync-dot' + (status === 'syncing' ? ' syncing' : status === 'error' ? ' error' : '');
    if (txt) txt.textContent = text;
}

// ===== TASK ICONS (SVG) =====
const TASK_ICONS = {
    alert: '<svg class="task-icon critical" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    overdue: '<svg class="task-icon critical" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    phone: '<svg class="task-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    calendar: '<svg class="task-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    meeting: '<svg class="task-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    check: '<svg class="task-icon success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    document: '<svg class="task-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    money: '<svg class="task-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    refresh: '<svg class="task-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
    target: '<svg class="task-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    warning: '<svg class="task-icon warning" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    sms: '<svg class="task-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
};

function taskIcon(type) {
    return TASK_ICONS[type] || TASK_ICONS.alert;
}
