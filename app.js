/**
 * jQuery-style Helper Function ($)
 */
const $ = (selector) => {
    const els = typeof selector === 'string'
        ? document.querySelectorAll(selector)
        : (selector instanceof HTMLElement ? [selector] : []);

    const api = {
        el: els[0],
        on: (event, handler) => { els.forEach(e => e.addEventListener(event, handler)); return api; },
        click: (handler) => api.on('click', handler),
        html: (content) => { if(content === undefined) return els[0]?.innerHTML; els.forEach(e => e.innerHTML = content); return api; },
        text: (content) => { if(content === undefined) return els[0]?.innerText; els.forEach(e => e.innerText = content); return api; },
        val: (content) => { if(content === undefined) return els[0]?.value; els.forEach(e => e.value = content); return api; },
        css: (prop, value) => { els.forEach(e => e.style[prop] = value); return api; },
        show: () => { els.forEach(e => e.style.display = 'block'); return api; },
        hide: () => { els.forEach(e => e.style.display = 'none'); return api; },
        toggle: (flag) => { els.forEach(e => e.style.display = flag ? 'block' : 'none'); return api; },
        addClass: (cls) => { els.forEach(e => e.classList.add(cls)); return api; },
        removeClass: (cls) => { els.forEach(e => e.classList.remove(cls)); return api; }
    };
    return api;
};

// --- Column index constants ---

const ATT = { NAME: 0, LOCATION: 1, MONTH: 2, DATE: 3, COST: 4, MEMBERSHIP: 6 };
const SUM = { NAME: 1, PENDING: 2, PREPAY: 3, TOTAL: 4, LAST_PAID_DATE: 7, LAST_PAID_AMT: 8, COVERED_UNTIL: 9 };

const MONTH_ORDER = {
    jan:0, january:0, feb:1, february:1, mar:2, march:2,
    apr:3, april:3, may:4, jun:5, june:5, jul:6, july:6,
    aug:7, august:7, sep:8, september:8, oct:9, october:9,
    nov:10, november:10, dec:11, december:11
};

const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const CONFIG = {
    apiKey: "AIzaSyB4FKQrbrtGpBztkZVriYkEGsXlnLXHAN0",
    sheetID: "1kI6E4J0pL4lUa2NH-FYEd2rWUE7Uzsz-CnGOg68ERtc",
    baseUrl: "https://sheets.googleapis.com/v4/spreadsheets"
};

let state = {
    summary: [],
    attendance: [],
    users: [],
    years: [],
    currentUser: null,
    attendanceSort: { col: null, asc: true },
    paymentSort: { col: null, asc: true }
};

let chartInstance = null;

// --- Utilities ---

const fmtMoney = (amt) => `${Math.abs(parseFloat(amt) || 0).toFixed(2)} MVR`;
const parseMoney = (str) => parseFloat(String(str).replace(/[^\d.-]/g, '')) || 0;
const parseDate = (str) => {
    if (!str) return null;
    const [d, m, y] = str.trim().split('/');
    return new Date(y, m - 1, d);
};

function getMembershipBadge(row) {
    const yr = (parseDate(row[ATT.DATE]) || new Date(0)).getFullYear();
    const raw = (row[ATT.MEMBERSHIP] || '').trim();
    const isError = !raw || raw.startsWith('#');

    if (yr < 2025) {
        if (isError || raw === 'Non-Member') return '<span class="status-badge status-pre-ufa">Pre-UFA</span>';
        return `<span class="status-badge status-member">${raw}</span>`;
    }
    if (raw === 'Non-Member') return '<span class="status-badge status-non-member">Non-Member</span>';
    return `<span class="status-badge status-member">${isError ? 'Member' : raw}</span>`;
}

// --- Financial Ledger Engine ---

function calculateFinancialLedger(userName) {
    const summaryRow = state.summary.find(r => r[SUM.NAME] === userName);
    const totalPaid = summaryRow ? parseMoney(summaryRow[SUM.TOTAL]) : 0;

    const sessions = state.attendance
        .filter(r => r[ATT.NAME] === userName)
        .map(r => ({
            date: parseDate(r[ATT.DATE]),
            dateStr: r[ATT.DATE],
            location: r[ATT.LOCATION],
            month: r[ATT.MONTH],
            cost: parseMoney(r[ATT.COST])
        }))
        .filter(r => r.date)
        .sort((a, b) => a.date - b.date);

    let cumulativeCost = 0;
    sessions.forEach(s => {
        const prev = cumulativeCost;
        cumulativeCost += s.cost;
        if (cumulativeCost <= totalPaid) {
            s.status = 'paid';
        } else if (prev < totalPaid) {
            s.status = 'partial';
        } else {
            s.status = 'unpaid';
        }
        s.cumulativeCost = cumulativeCost;
    });

    const unpaidCount = sessions.filter(s => s.status === 'unpaid').length;
    const partialCount = sessions.filter(s => s.status === 'partial').length;
    const pendingCount = unpaidCount + partialCount;

    return { sessions, totalPaid, cumulativeCost, unpaidCount, partialCount, pendingCount };
}

function getHealthBadge(ledger) {
    if (ledger.sessions.length === 0) return '';
    if (ledger.pendingCount === 0) {
        if (ledger.totalPaid > ledger.cumulativeCost) {
            return '<span class="health-badge health-prepaid">Status: Prepaid</span>';
        }
        return '<span class="health-badge health-caught-up">Status: Caught Up</span>';
    }
    const label = ledger.pendingCount === 1
        ? '1 Session Pending'
        : `${ledger.pendingCount} Sessions Pending`;
    return `<span class="health-badge health-pending">Status: ${label}</span>`;
}

// --- Init ---

async function initApp() {
    try {
        $('#loadingState').show();

        const [summaryRes, attendanceRes, metaRes] = await Promise.all([
            fetch(`${CONFIG.baseUrl}/${CONFIG.sheetID}/values/Summary Sheet?key=${CONFIG.apiKey}`).then(r=>r.json()),
            fetch(`${CONFIG.baseUrl}/${CONFIG.sheetID}/values/PivotAttendance?key=${CONFIG.apiKey}`).then(r=>r.json()),
            fetch(`${CONFIG.baseUrl}/${CONFIG.sheetID}?key=${CONFIG.apiKey}&fields=properties.lastUpdateTime`).then(r=>r.json())
        ]);

        state.summary = summaryRes.values.slice(1);
        state.attendance = attendanceRes.values.slice(1);
        state.users = [...new Set(state.summary.map(r => r[SUM.NAME]))].filter(Boolean).sort();

        const lastUpdate = metaRes.properties?.lastUpdateTime
            ? new Date(metaRes.properties.lastUpdateTime).toLocaleDateString()
            : new Date().toLocaleDateString();
        $('#lastUpdated').text(`Updated ${lastUpdate}`);

        populateFilters();
        setupEventListeners();
        $('#loadingState').hide();

        const urlUser = new URLSearchParams(window.location.search).get('user');
        if (urlUser && state.users.includes(decodeURIComponent(urlUser))) {
            selectUser(decodeURIComponent(urlUser));
        } else {
            $('#welcomeMessage').show();
        }

    } catch (e) {
        console.error(e);
        $('#loadingState').html(`<div class="text-red">⚠️ Error loading data. Please refresh.</div>`);
    }
}

function populateFilters() {
    const months = [...new Set(state.attendance.map(r => r[ATT.MONTH]))].filter(Boolean);
    const locations = [...new Set(state.attendance.map(r => r[ATT.LOCATION]))].filter(Boolean);

    const years = [...new Set(state.attendance.map(r => {
        const d = parseDate(r[ATT.DATE]);
        return d ? d.getFullYear().toString() : null;
    }).filter(Boolean))].sort((a, b) => b - a);

    state.years = years;

    const monthOpts = months.map(m => `<option value="${m}">${m}</option>`).join('');
    const locOpts = locations.map(l => `<option value="${l}">${l}</option>`).join('');
    const yearOpts = years.map(y => `<option value="${y}">${y}</option>`).join('');

    $('#monthFilter').html(`<option value="all">All Months</option>${monthOpts}`);
    $('#locationFilter').html(`<option value="all">All Locations</option>${locOpts}`);
    $('#yearFilter').html(`<option value="all">All Years</option>${yearOpts}`);
}

// --- User Dashboard ---

function renderUserDashboard(userName) {
    $('#welcomeMessage').hide();
    $('#allDataView').hide();
    $('#userDashboard').show();
    $('#selectedUserName').text(userName);

    const summaryRow = state.summary.find(r => r[SUM.NAME] === userName);
    const attRows = state.attendance.filter(r => r[ATT.NAME] === userName);

    if (summaryRow) {
        const pending = parseMoney(summaryRow[SUM.PENDING]);
        const prepay = parseMoney(summaryRow[SUM.PREPAY]);

        $('#pendingAmount').text(fmtMoney(pending));
        $('#prepayAmount').text(fmtMoney(prepay));
        $('#totalPayment').text(fmtMoney(summaryRow[SUM.TOTAL]));
        $('#lastPaymentDate').text(summaryRow[SUM.LAST_PAID_DATE] || '-');
        $('#lastPaymentAmount').text(summaryRow[SUM.LAST_PAID_AMT] ? fmtMoney(parseMoney(summaryRow[SUM.LAST_PAID_AMT])) : '-');
        $('#lastCoveredDate').text(summaryRow[SUM.COVERED_UNTIL] || '-');

        if (pending > 0) {
            $('#pendingActionArea').html(`
                <div style="background: #fff0f0; padding: 15px; border-radius: 12px; border: 1px solid #ffcdd2; display: flex; align-items: center; justify-content: center; gap: 20px;">
                    <div style="flex-shrink: 0; cursor: pointer;" onclick="$('#qrModal').css('display', 'flex')">
                        <img src="payment_qr.png" alt="Scan to Pay" style="width: 100px; height: 100px; object-fit: cover; border-radius: 8px; border: 1px solid #eee; display: block;">
                        <div style="font-size: 0.7rem; color: #666; text-align: center; margin-top: 4px;">(Click to Enlarge)</div>
                    </div>

                    <div>
                        <p style="margin: 0; line-height: 1.5; text-align: left;">
                            <strong style="color: #c62828; font-size: 1.1rem;">⚠️ Outstanding Balance: ${fmtMoney(pending)}</strong><br>
                            <span style="color: #555;">Transfer to: <strong>7730000682000</strong> (MOHD. AMSAL)</span>
                        </p>
                    </div>
                </div>
            `).show();
        } else {
            $('#pendingActionArea').hide();
        }
    }

    // Stats
    const paidSessions = attRows.filter(r => parseMoney(r[ATT.COST]) > 0);
    const totalCost = paidSessions.reduce((acc, r) => acc + parseMoney(r[ATT.COST]), 0);
    const avg = paidSessions.length ? totalCost / paidSessions.length : 0;

    $('#totalSessions').text(attRows.length);
    $('#avgCost').text(Math.round(avg) + ' MVR');

    // Year session cards
    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentCount = attRows.filter(r => parseDate(r[ATT.DATE]) >= thirtyDaysAgo).length;

    const yearCards = (state.years || []).map(y => {
        const count = attRows.filter(r => { const d = parseDate(r[ATT.DATE]); return d && d.getFullYear().toString() === y; }).length;
        return `<div class="summary-item neutral"><div class="summary-value">${count}</div><div class="summary-label">${y} Sessions</div></div>`;
    }).join('');

    $('#yearSessionCards').html(
        yearCards + `<div class="summary-item neutral"><div class="summary-value">${recentCount}</div><div class="summary-label">Last 30 Days</div></div>`
    );

    // Financial ledger + health badge
    const ledger = calculateFinancialLedger(userName);
    $('#healthBadge').html(getHealthBadge(ledger));

    // Render new components
    renderFinancialChart(ledger);
    renderSessionStatus(ledger);
    renderAttendanceTable(attRows);
}

// --- Financial Burn-Up Chart ---

function renderFinancialChart(ledger) {
    const ctx = document.getElementById('financialChart').getContext('2d');

    if (chartInstance) chartInstance.destroy();

    if (ledger.sessions.length === 0) {
        ctx.canvas.parentElement.innerHTML = '<div class="loading">No session data to chart.</div>';
        return;
    }

    const labels = ledger.sessions.map(s => {
        return `${s.date.getDate()} ${SHORT_MONTHS[s.date.getMonth()]} ${String(s.date.getFullYear()).slice(2)}`;
    });

    const cumulativeCosts = ledger.sessions.map(s => s.cumulativeCost);
    const paidLine = ledger.sessions.map(() => ledger.totalPaid);

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Total Owed',
                    data: cumulativeCosts,
                    stepped: true,
                    borderColor: 'rgb(239, 83, 80)',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointRadius: 1.5,
                    pointHoverRadius: 4,
                    fill: {
                        target: 1,
                        above: 'rgba(239, 83, 80, 0.12)',
                        below: 'rgba(76, 175, 80, 0.12)'
                    }
                },
                {
                    label: 'Total Paid',
                    data: paidLine,
                    borderColor: 'rgb(76, 175, 80)',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    borderDash: [6, 3],
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: {
                    ticks: { autoSkip: true, maxRotation: 45, font: { size: 10 } }
                },
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) { return value + ' MVR'; }
                    }
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        title: function(items) {
                            const idx = items[0].dataIndex;
                            const s = ledger.sessions[idx];
                            return `${s.dateStr} — ${s.location}`;
                        },
                        afterBody: function(items) {
                            const idx = items[0].dataIndex;
                            const s = ledger.sessions[idx];
                            const label = s.status === 'paid' ? 'Paid' : s.status === 'partial' ? 'Partial' : 'Unpaid';
                            return [`Session cost: ${fmtMoney(s.cost)}`, `Status: ${label}`];
                        }
                    }
                },
                legend: { display: true, position: 'top' },
                filler: { propagate: true }
            }
        }
    });
}

// --- FIFO Session Status Cards ---

function renderSessionStatus(ledger) {
    const container = $('#sessionStatusCards');

    if (ledger.sessions.length === 0) {
        container.html('<div style="color: #888; font-size: 0.9rem;">No sessions found.</div>');
        return;
    }

    const recent = ledger.sessions.slice(-10);

    const cards = recent.map(s => {
        const statusLabel = s.status === 'paid' ? 'Paid' : s.status === 'partial' ? 'Partial' : 'Unpaid';
        const dateLabel = `${s.date.getDate()} ${SHORT_MONTHS[s.date.getMonth()]}`;

        return `<div class="fifo-card fifo-${s.status}" title="${s.dateStr} — ${statusLabel} — ${fmtMoney(s.cost)}">
            <div class="fifo-date">${dateLabel}</div>
            <div class="fifo-cost">${fmtMoney(s.cost)}</div>
        </div>`;
    }).join('');

    container.html(cards);
}

// --- Attendance Table ---

function renderAttendanceTable(data) {
    const mFilter = $('#monthFilter').val();
    const yFilter = $('#yearFilter').val();
    const lFilter = $('#locationFilter').val();

    let rows = data.filter(r => {
        if (mFilter !== 'all' && r[ATT.MONTH] !== mFilter) return false;
        if (yFilter !== 'all' && !r[ATT.DATE].includes(yFilter)) return false;
        if (lFilter !== 'all' && r[ATT.LOCATION] !== lFilter) return false;
        return true;
    });

    const sort = state.attendanceSort;
    if (sort.col) {
        rows.sort((a, b) => {
            let valA, valB;
            switch(sort.col) {
                case 'date': valA = parseDate(a[ATT.DATE]) || new Date(0); valB = parseDate(b[ATT.DATE]) || new Date(0); break;
                case 'month': valA = MONTH_ORDER[(a[ATT.MONTH] || '').toLowerCase()] ?? 99; valB = MONTH_ORDER[(b[ATT.MONTH] || '').toLowerCase()] ?? 99; break;
                case 'location': valA = (a[ATT.LOCATION] || '').toLowerCase(); valB = (b[ATT.LOCATION] || '').toLowerCase(); break;
                case 'cost': valA = parseMoney(a[ATT.COST]); valB = parseMoney(b[ATT.COST]); break;
                case 'status': valA = (a[ATT.MEMBERSHIP] || '').toLowerCase(); valB = (b[ATT.MEMBERSHIP] || '').toLowerCase(); break;
                default: valA = 0; valB = 0;
            }
            return sort.asc ? (valA > valB ? 1 : -1) : (valA < valB ? 1 : -1);
        });
    }

    const html = rows.length ? rows.map(r => `
        <tr>
            <td>${r[ATT.DATE]}</td>
            <td>${r[ATT.LOCATION]}</td>
            <td>${r[ATT.MONTH]}</td>
            <td>${fmtMoney(parseMoney(r[ATT.COST]))}</td>
            <td>${getMembershipBadge(r)}</td>
        </tr>
    `).join('') : `<tr><td colspan="5" class="loading">No records found.</td></tr>`;

    $('#attendanceTable tbody').html(html);
}

// --- All Payments Table ---

function renderAllPayments() {
    $('#welcomeMessage').hide();
    $('#userDashboard').hide();
    $('#allDataView').show();

    const statusFilter = $('#paymentStatusFilter').val();
    const showNeverPaid = $('#neverPaidToggle').el.checked;

    if (statusFilter === 'pending') {
        $('#neverPaidFilterGroup').css('display', 'flex');
    } else {
        $('#neverPaidFilterGroup').hide();
    }

    let data = state.summary.filter(r => {
        const pend = parseMoney(r[SUM.PENDING]);
        const pre = parseMoney(r[SUM.PREPAY]);

        if (statusFilter === 'pending') {
            const isPending = pend > 0;
            if (isPending && showNeverPaid) {
                const coveredDate = r[SUM.COVERED_UNTIL];
                const hasNoDate = !coveredDate || coveredDate === '-' || coveredDate.trim() === '';
                return hasNoDate;
            }
            return isPending;
        }

        if (statusFilter === 'prepaid') return pre > 0;
        if (statusFilter === 'balanced') return (pre - pend) === 0;
        return true;
    });

    const sort = state.paymentSort;
    if (sort.col) {
        data.sort((a, b) => {
            let valA, valB;
            switch(sort.col) {
                case 'name': valA = a[SUM.NAME].toLowerCase(); valB = b[SUM.NAME].toLowerCase(); break;
                case 'pending': valA = parseMoney(a[SUM.PENDING]); valB = parseMoney(b[SUM.PENDING]); break;
                case 'prepay': valA = parseMoney(a[SUM.PREPAY]); valB = parseMoney(b[SUM.PREPAY]); break;
                case 'total': valA = parseMoney(a[SUM.TOTAL]); valB = parseMoney(b[SUM.TOTAL]); break;
                case 'lastDate': valA = parseDate(a[SUM.COVERED_UNTIL]) || new Date(0); valB = parseDate(b[SUM.COVERED_UNTIL]) || new Date(0); break;
            }
            return sort.asc ? (valA > valB ? 1 : -1) : (valA < valB ? 1 : -1);
        });
    }

    let tPending = 0, tPrepay = 0, tPaid = 0;

    const html = data.map(r => {
        const name = r[SUM.NAME];
        const pend = parseMoney(r[SUM.PENDING]);
        const pre = parseMoney(r[SUM.PREPAY]);
        const tot = parseMoney(r[SUM.TOTAL]);

        tPending += pend; tPrepay += pre; tPaid += tot;

        const actionBtn = pend > 0
            ? `<button class="btn btn-primary copy-btn" data-name="${name}" data-amt="${pend}" data-date="${r[SUM.COVERED_UNTIL] || ''}" style="padding:5px 10px; font-size:12px;">📋 Copy</button>`
            : '';

        return `
            <tr>
                <td><a href="#" class="text-link user-link" data-name="${name}">${name}</a></td>
                <td class="${pend > 0 ? 'text-red' : ''}">${fmtMoney(pend)}</td>
                <td class="${pre > 0 ? 'text-green' : ''}">${fmtMoney(pre)}</td>
                <td style="font-weight:bold">${fmtMoney(tot)}</td>
                <td>${r[SUM.COVERED_UNTIL] || '-'}</td>
                <td>${actionBtn}</td>
            </tr>
        `;
    }).join('');

    $('#allPaymentsTable tbody').html(html);
    $('#totalPendingSum').text(fmtMoney(tPending));
    $('#totalPrepaySum').text(fmtMoney(tPrepay));
    $('#totalPaymentSum').text(fmtMoney(tPaid));
}

// --- Actions ---

function selectUser(name) {
    state.currentUser = name;
    $('#nameSearch').val(name);
    $('#searchSuggestions').hide();

    const newUrl = `${window.location.pathname}?user=${encodeURIComponent(name)}`;
    window.history.pushState({path: newUrl}, '', newUrl);

    renderUserDashboard(name);
}

document.addEventListener('click', async (e) => {
    if (e.target.classList.contains('user-link')) {
        e.preventDefault();
        selectUser(e.target.dataset.name);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    if (e.target.classList.contains('copy-btn')) {
        const btn = e.target;
        const { name, amt, date } = btn.dataset;
        const link = `${window.location.origin}${window.location.pathname}?user=${encodeURIComponent(name)}`;
        const msg = `Hey ${name}, you have unpaid Frisbee field booking fees of ${parseFloat(amt).toFixed(2)} MVR pending since ${date || 'your last session'}.\nYou can view the session cost details at: ${link}\n\n Please pay to the following account: 7730000682000 (MOHD. AMSAL)`;

        try {
            await navigator.clipboard.writeText(msg);
            const oldTxt = btn.innerText;
            btn.innerText = "\u2713 Copied";
            btn.style.background = "#2e7d32";
            setTimeout(() => { btn.innerText = oldTxt; btn.style.background = ""; }, 2000);
        } catch(err) { alert("Could not copy text."); }
    }
});

// --- Event Listeners ---

function setupEventListeners() {
    $('#nameSearch').on('input', (e) => {
        const val = e.target.value.toLowerCase().trim();
        if (!val) { $('#searchSuggestions').hide(); return; }

        const matches = state.users.filter(u => u.toLowerCase().includes(val)).slice(0, 10);
        if (matches.length) {
            const html = matches.map(name =>
                `<button class="btn btn-secondary suggestion-btn" onclick="selectUser('${name}')">${name}</button>`
            ).join('');
            $('#suggestionList').html(html);
            $('#searchSuggestions').show();
        } else {
            $('#searchSuggestions').hide();
        }
    });

    $('#clearSearch').click(() => {
        $('#nameSearch').val('');
        $('#searchSuggestions').hide();
        $('#welcomeMessage').show();
        $('#userDashboard').hide();
        $('#allDataView').hide();
        window.history.pushState({}, '', window.location.pathname);
    });

    $('#showAllData').click(() => {
        state.paymentSort = { col: null, asc: true };
        renderAllPayments();
    });

    $('.att-filter').on('change', () => {
         renderAttendanceTable(state.attendance.filter(r => r[ATT.NAME] === state.currentUser));
    });

    $('#paymentStatusFilter').on('change', renderAllPayments);
    $('#neverPaidToggle').on('change', renderAllPayments);

    $('.close-modal, .close-modal-btn').on('click', () => $('#qrModal').hide());

    // Attendance table headers
    $('#attendanceTable th[data-sort]').click(function() {
        const col = this.getAttribute('data-sort');
        const sort = state.attendanceSort;
        if (sort.col === col) sort.asc = !sort.asc;
        else { sort.col = col; sort.asc = true; }

        $('#attendanceTable th').removeClass('sort-asc').removeClass('sort-desc');
        $(this).addClass(sort.asc ? 'sort-asc' : 'sort-desc');

        renderAttendanceTable(state.attendance.filter(r => r[ATT.NAME] === state.currentUser));
    });

    // Payment table headers
    $('#allPaymentsTable th[data-sort]').click(function() {
        const col = this.getAttribute('data-sort');
        const sort = state.paymentSort;
        if (sort.col === col) sort.asc = !sort.asc;
        else { sort.col = col; sort.asc = true; }

        $('#allPaymentsTable th').removeClass('sort-asc').removeClass('sort-desc');
        $(this).addClass(sort.asc ? 'sort-asc' : 'sort-desc');

        renderAllPayments();
    });
}

document.addEventListener('DOMContentLoaded', initApp);
window.selectUser = selectUser;
