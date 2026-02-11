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
const PAY = { DATE: 0, NAME: 1, PLAYER_ID: 2, COMMENT: 3, REFERENCE: 4, TXN_DATE: 5, FROM: 6, TO: 7, ACCOUNT: 8, AMOUNT: 9, REMARKS: 10, PREPAYMENT: 11 };

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
    payments: [],
    users: [],
    years: [],
    currentUser: null,
    attendanceSort: { col: null, asc: true },
    paymentSort: { col: null, asc: true }
};

let financialChartInstance = null;
let activityChartInstance = null;

// --- Utilities ---

const fmtMoney = (amt) => `${(parseFloat(amt) || 0).toFixed(2)} MVR`;
const parseMoney = (str) => parseFloat(String(str).replace(/[^\d.-]/g, '')) || 0;
const parseDate = (str) => {
    if (!str || typeof str !== 'string') return null;

    const parts = str.trim().split('/');
    if (parts.length !== 3) return null;

    const [d, m, y] = parts.map(p => parseInt(p, 10));
    if (isNaN(d) || isNaN(m) || isNaN(y)) return null;

    // Validate the date is real (catches invalid dates like 32/13/2024)
    const date = new Date(y, m - 1, d);
    if (date.getDate() !== d || date.getMonth() !== m - 1 || date.getFullYear() !== y) {
        return null;
    }

    return date;
};
const fmtDateShort = (d) => `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;

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
    // Financial tracking started July 1st, 2024 - only include data from then onwards
    const trackingStartDate = new Date(2024, 6, 1); // July 1, 2024 (month is 0-indexed)

    // Cost events from attendance (only from tracking start date)
    const costEvents = state.attendance
        .filter(r => r[ATT.NAME] === userName)
        .map(r => ({
            date: parseDate(r[ATT.DATE]),
            dateStr: r[ATT.DATE],
            location: r[ATT.LOCATION],
            month: r[ATT.MONTH],
            type: 'cost',
            amount: parseMoney(r[ATT.COST])
        }))
        .filter(r => r.date && r.date >= trackingStartDate); // Filter by tracking start date

    // Payment events from Payments sheet (only from tracking start date)
    const payEvents = (state.payments || [])
        .filter(r => r[PAY.NAME] === userName)
        .map(r => ({
            date: parseDate(r[PAY.DATE]),
            dateStr: r[PAY.DATE],
            type: 'payment',
            amount: parseMoney(r[PAY.AMOUNT]),
            reference: r[PAY.REFERENCE] || ''
        }))
        .filter(r => r.date && r.amount > 0 && r.date >= trackingStartDate); // Filter by tracking start date

    // Unified timeline sorted by date
    const timeline = [...costEvents, ...payEvents].sort((a, b) => a.date - b.date);

    let cumCost = 0, cumPaid = 0;
    timeline.forEach(e => {
        if (e.type === 'cost') cumCost += e.amount;
        else cumPaid += e.amount;
        e.cumulativeCost = cumCost;
        e.cumulativePaid = cumPaid;
    });

    // FIFO status on cost events only using final total paid
    const totalPaid = cumPaid;
    const sessions = costEvents.sort((a, b) => a.date - b.date);
    let runningCost = 0;
    sessions.forEach(s => {
        const prev = runningCost;
        runningCost += s.amount;
        if (runningCost <= totalPaid) s.status = 'paid';
        else if (prev < totalPaid) s.status = 'partial';
        else s.status = 'unpaid';
        s.cumulativeCost = runningCost;
    });

    const unpaidCount = sessions.filter(s => s.status === 'unpaid').length;
    const partialCount = sessions.filter(s => s.status === 'partial').length;
    const pendingCount = unpaidCount + partialCount;

    return { timeline, sessions, totalPaid, cumulativeCost: cumCost, cumulativePaid: cumPaid, unpaidCount, partialCount, pendingCount };
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

// --- Network Utilities ---

async function fetchWithRetry(url, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            return await response.json();
        } catch (e) {
            if (i === retries - 1) throw e; // Last attempt failed
            console.warn(`Fetch attempt ${i + 1} failed, retrying in ${delay * (i + 1)}ms...`);
            await new Promise(r => setTimeout(r, delay * (i + 1)));
        }
    }
}

// --- Init ---

async function initApp() {
    try {
        $('#loadingState').show();

        // Fetch main data only (removed metadata fetch - was causing 100% API errors)
        const [summaryRes, attendanceRes, paymentsRes] = await Promise.all([
            fetchWithRetry(`${CONFIG.baseUrl}/${CONFIG.sheetID}/values/Summary Sheet?key=${CONFIG.apiKey}`),
            fetchWithRetry(`${CONFIG.baseUrl}/${CONFIG.sheetID}/values/PivotAttendance?key=${CONFIG.apiKey}`),
            fetchWithRetry(`${CONFIG.baseUrl}/${CONFIG.sheetID}/values/Payments?key=${CONFIG.apiKey}`)
        ]);

        // Validate API responses
        if (!summaryRes.values || summaryRes.values.length < 2) {
            console.error('Summary data issue:', summaryRes);
            throw new Error("Invalid or empty summary data from Google Sheets");
        }
        if (!attendanceRes.values || attendanceRes.values.length < 2) {
            console.error('Attendance data issue:', attendanceRes);
            throw new Error("Invalid or empty attendance data from Google Sheets");
        }

        // Process data (be more lenient with row validation)
        const rawSummary = summaryRes.values.slice(1);
        const rawAttendance = attendanceRes.values.slice(1);
        const rawPayments = (paymentsRes.values || []).slice(1);

        console.log(`Raw data counts - Summary: ${rawSummary.length}, Attendance: ${rawAttendance.length}, Payments: ${rawPayments.length}`);

        // Filter out completely empty rows, but be lenient with column count
        state.summary = rawSummary.filter(row => row && row.length > 0 && row[SUM.NAME]);
        state.attendance = rawAttendance.filter(row => row && row.length > 0 && row[ATT.NAME]);
        state.payments = rawPayments.filter(row => row && row.length > 0);
        state.users = [...new Set(state.summary.map(r => r[SUM.NAME]))].filter(Boolean).sort();

        console.log(`Filtered data counts - Summary: ${state.summary.length}, Attendance: ${state.attendance.length}, Payments: ${state.payments.length}`);

        if (state.summary.length === 0 || state.attendance.length === 0) {
            throw new Error(`No valid data found. Summary: ${state.summary.length} rows, Attendance: ${state.attendance.length} rows`);
        }

        // Use current date for "Updated" timestamp (removed API call to avoid quota issues)
        const lastUpdate = new Date().toLocaleDateString();
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
        console.error('App initialization error:', e);
        $('#loadingState').html(`
            <div class="text-red">
                ⚠️ Error loading data: ${e.message}<br>
                <small>Please refresh the page or contact support if the issue persists.</small>
            </div>
        `);
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
    // chartYearFilter removed - now using year buttons instead
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
                    <div class="qr-thumbnail" style="flex-shrink: 0; cursor: pointer;">
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

            // Add click event for QR thumbnail
            $('.qr-thumbnail').on('click', () => $('#qrModal').css('display', 'flex'));
        } else {
            $('#pendingActionArea').hide();
        }
    }

    // Stats for Payment Summary tab
    const paidSessions = attRows.filter(r => parseMoney(r[ATT.COST]) > 0);
    const totalCost = paidSessions.reduce((acc, r) => acc + parseMoney(r[ATT.COST]), 0);
    const avg = paidSessions.length ? totalCost / paidSessions.length : 0;

    $('#totalSessions').text(attRows.length);
    $('#avgCost').text(Math.round(avg) + ' MVR');

    // Year session cards for Activity tab - only show years with sessions
    const thirtyDaysAgo = new Date(); thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const recentCount = attRows.filter(r => parseDate(r[ATT.DATE]) >= thirtyDaysAgo).length;

    // Calculate sessions per year and filter out years with 0 sessions
    const yearData = (state.years || []).map(y => {
        const count = attRows.filter(r => { const d = parseDate(r[ATT.DATE]); return d && d.getFullYear().toString() === y; }).length;
        return { year: y, count };
    }).filter(item => item.count > 0); // Only include years with sessions

    const yearCards = yearData.map(item =>
        `<div class="summary-item neutral"><div class="summary-value">${item.count}</div><div class="summary-label">${item.year} Sessions</div></div>`
    ).join('');

    $('#yearSessionCards').html(
        yearCards + `<div class="summary-item neutral"><div class="summary-value">${recentCount}</div><div class="summary-label">Last 30 Days</div></div>`
    );

    // Generate year buttons (only for years with sessions)
    if (yearData.length > 0) {
        const firstYear = yearData[0].year; // Default to first available year
        const yearButtons = yearData.map(item =>
            `<button class="year-btn${item.year === firstYear ? ' active' : ''}" data-year="${item.year}">${item.year}</button>`
        ).join('');
        $('#chartYearButtons').html(yearButtons);

        // Set up click events for year buttons
        document.querySelectorAll('.year-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                document.querySelectorAll('.year-btn').forEach(b => b.classList.remove('active'));
                this.classList.add('active');
                if (state.currentUser) {
                    const userRows = state.attendance.filter(r => r[ATT.NAME] === state.currentUser);
                    renderActivityChart(userRows);
                }
            });
        });
    }

    // Financial ledger + health badge
    const ledger = calculateFinancialLedger(userName);
    $('#healthBadge').html(getHealthBadge(ledger));

    // Render components
    renderFinancialChart(ledger);
    renderSessionStatus(ledger);
    renderAttendanceTable(attRows);

    // Render activity chart if that tab is currently visible
    if ($('#tabActivityOverview').el?.classList.contains('active')) {
        renderActivityChart(attRows);
    }
}

// --- Financial Burn-Up Chart ---

function renderFinancialChart(ledger) {
    const ctx = document.getElementById('financialChart').getContext('2d');

    if (financialChartInstance) financialChartInstance.destroy();

    // Don't show chart if no data or if both totals are 0
    if (ledger.timeline.length === 0) {
        ctx.canvas.parentElement.innerHTML = '<div class="loading">No session data to chart.</div>';
        return;
    }

    const finalCost = ledger.cumulativeCost || 0;
    const finalPaid = ledger.cumulativePaid || 0;

    if (finalCost === 0 && finalPaid === 0) {
        ctx.canvas.parentElement.innerHTML = '<div class="loading">No financial activity yet.</div>';
        return;
    }

    const labels = ledger.timeline.map(e => fmtDateShort(e.date));
    const cumCosts = ledger.timeline.map(e => e.cumulativeCost);
    const cumPaids = ledger.timeline.map(e => e.cumulativePaid);

    // Create arrays for point styling - make payment events more visible
    const costPointStyles = ledger.timeline.map(e => e.type === 'payment' ? 'rectRot' : 'circle');
    const costPointRadii = ledger.timeline.map(e => e.type === 'payment' ? 6 : 2);
    const costPointColors = ledger.timeline.map(e =>
        e.type === 'payment' ? 'rgb(76, 175, 80)' : 'rgb(239, 83, 80)'
    );

    const paidPointStyles = ledger.timeline.map(e => e.type === 'payment' ? 'star' : 'circle');
    const paidPointRadii = ledger.timeline.map(e => e.type === 'payment' ? 7 : 2);
    const paidPointColors = ledger.timeline.map(e =>
        e.type === 'payment' ? 'rgb(46, 125, 50)' : 'rgb(76, 175, 80)'
    );

    financialChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Total Owed',
                    data: cumCosts,
                    stepped: true,
                    borderColor: 'rgb(239, 83, 80)',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointStyle: costPointStyles,
                    pointRadius: costPointRadii,
                    pointBackgroundColor: costPointColors,
                    pointBorderColor: costPointColors,
                    pointHoverRadius: 8,
                    fill: {
                        target: 1,
                        above: 'rgba(239, 83, 80, 0.12)',
                        below: 'rgba(76, 175, 80, 0.12)'
                    }
                },
                {
                    label: 'Total Paid',
                    data: cumPaids,
                    stepped: true,
                    borderColor: 'rgb(76, 175, 80)',
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointStyle: paidPointStyles,
                    pointRadius: paidPointRadii,
                    pointBackgroundColor: paidPointColors,
                    pointBorderColor: paidPointColors,
                    pointHoverRadius: 8,
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
                    ticks: {
                        autoSkip: true,
                        maxRotation: 45,
                        minRotation: 0,
                        font: { size: 9 } // Smaller for mobile
                    }
                },
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) { return value + ' MVR'; },
                        font: { size: 10 }
                    }
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        title: function(items) {
                            const idx = items[0].dataIndex;
                            const e = ledger.timeline[idx];
                            if (e.type === 'cost') return `${e.dateStr} — ${e.location}`;
                            return `💰 ${e.dateStr} — Payment`;
                        },
                        afterBody: function(items) {
                            const idx = items[0].dataIndex;
                            const e = ledger.timeline[idx];
                            if (e.type === 'cost') return [`Session cost: ${fmtMoney(e.amount)}`];
                            return [`Payment: ${fmtMoney(e.amount)}`, e.reference ? `Ref: ${e.reference}` : ''].filter(Boolean);
                        }
                    }
                },
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        font: { size: 11 }, // Smaller for mobile
                        padding: 10,
                        usePointStyle: true
                    }
                },
                filler: { propagate: true }
            }
        }
    });
}

// --- Activity Overview Chart (bar chart, sessions per month) ---

function renderActivityChart(attRows) {
    const ctx = document.getElementById('activityChart').getContext('2d');
    const selectedYear = document.querySelector('.year-btn.active')?.dataset.year || new Date().getFullYear().toString();

    const stats = Array.from({length: 12}, () => ({ count: 0, totalCost: 0 }));

    attRows.forEach(r => {
        const date = parseDate(r[ATT.DATE]);
        if (date && date.getFullYear().toString() === selectedYear) {
            const monthIdx = date.getMonth();
            stats[monthIdx].count++;
            stats[monthIdx].totalCost += parseMoney(r[ATT.COST]);
        }
    });

    const counts = stats.map(s => s.count);
    const avgCosts = stats.map(s => s.count ? (s.totalCost / s.count).toFixed(2) : 0);

    if (activityChartInstance) activityChartInstance.destroy();

    activityChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: SHORT_MONTHS,
            datasets: [
                {
                    type: 'bar',
                    label: 'Sessions',
                    data: counts,
                    backgroundColor: 'rgba(72, 141, 170, 0.6)',
                    borderColor: 'rgba(72, 141, 170, 1)',
                    borderWidth: 1,
                    borderRadius: 4,
                    hoverBackgroundColor: 'rgba(72, 141, 170, 0.8)',
                    yAxisID: 'y'
                },
                {
                    type: 'line',
                    label: 'Avg Cost (MVR)',
                    data: avgCosts,
                    borderColor: 'rgba(255, 99, 132, 1)',
                    backgroundColor: 'rgba(255, 99, 132, 0.1)',
                    borderWidth: 2,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    tension: 0.3,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            scales: {
                y: {
                    type: 'linear',
                    position: 'left',
                    beginAtZero: true,
                    ticks: { stepSize: 1 },
                    title: { display: true, text: 'Sessions' }
                },
                y1: {
                    type: 'linear',
                    position: 'right',
                    beginAtZero: true,
                    grid: { drawOnChartArea: false },
                    title: { display: true, text: 'Avg Cost (MVR)' }
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.dataset.label || '';
                            const value = context.parsed.y;
                            if (label.includes('Cost')) {
                                return ` ${label}: ${value} MVR`;
                            }
                            return ` ${label}: ${value}`;
                        }
                    }
                },
                legend: { display: true, position: 'top' }
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

        return `<div class="fifo-card fifo-${s.status}" title="${s.dateStr} — ${statusLabel} — ${fmtMoney(s.cost || s.amount)}">
            <div class="fifo-date">${dateLabel}</div>
            <div class="fifo-cost">${fmtMoney(s.cost || s.amount)}</div>
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
    // Default sort: most recent first (if no sort applied yet)
    if (!sort.col) {
        sort.col = 'date';
        sort.asc = false; // Descending (most recent first)
    }

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
        if (statusFilter === 'balanced') return Math.abs(pre - pend) < 0.01; // Floating point tolerance
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
                `<button class="btn btn-secondary suggestion-btn" data-user-name="${name}">${name}</button>`
            ).join('');
            $('#suggestionList').html(html);
            $('#searchSuggestions').show();

            // Add click events for suggestion buttons
            document.querySelectorAll('.suggestion-btn').forEach(btn => {
                btn.addEventListener('click', () => selectUser(btn.dataset.userName));
            });
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

    // Tab switching
    $('.tab-btn').on('click', function() {
        const tab = this.getAttribute('data-tab');
        $('.tab-btn').removeClass('active');
        $(this).addClass('active');
        $('#tabPaymentSummary').el.classList.toggle('active', tab === 'paymentSummary');
        $('#tabActivityOverview').el.classList.toggle('active', tab === 'activityOverview');

        // Render activity chart when its tab becomes visible (canvas must be visible)
        if (tab === 'activityOverview' && state.currentUser) {
            const userRows = state.attendance.filter(r => r[ATT.NAME] === state.currentUser);
            renderActivityChart(userRows);
        }
    });

    // Year filter now handled by year button clicks (see renderUserDashboard)

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
