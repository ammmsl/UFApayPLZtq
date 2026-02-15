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

// NOTE: Actual data structure from PivotAttendance sheet
// The headers say: "Date Pull, Month, Location, Name, Player ID, Cost Per, Membership, Surcharge"
// But the actual data appears to be in a different order (likely due to pivot structure)
// Based on actual data inspection: Name at 0, Location at 1, Month at 2, Date at 3, etc.
const ATT = {
    NAME: 0,         // Player Name (confirmed from data: 'Afrah', 'Aikko', etc.)
    LOCATION: 1,     // Location
    MONTH: 2,        // Month
    DATE: 3,         // Session Date (confirmed from data: '05/01/2024', etc.)
    COST: 4,         // Cost Per
    PLAYER_ID: 5,    // Player ID
    MEMBERSHIP: 6,   // Membership status
    SURCHARGE: 7     // Surcharge (calculated value)
};
const SUM = { NAME: 1, PENDING: 2, PREPAY: 3, TOTAL: 4, LAST_PAID_DATE: 7, LAST_PAID_AMT: 8, COVERED_UNTIL: 9 };
// Payments sheet: DATE, NAME, PLAYER_ID, COMMENT, REFERENCE, TXN_DATE, FROM, TO, ACCOUNT, AMOUNT, REMARKS, PREPAYMENT
// PREPAYMENT column values: "Prepay", "PostPay", "Adjustment", "Field Booking"
const PAY = { DATE: 0, NAME: 1, PLAYER_ID: 2, COMMENT: 3, REFERENCE: 4, TXN_DATE: 5, FROM: 6, TO: 7, ACCOUNT: 8, AMOUNT: 9, REMARKS: 10, PREPAYMENT: 11 };
const SESSION = { DATE: 0, FIELD_COST: 6 }; // Session Input sheet: Column A = Date, Column G = Field Booking Cost

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
    sessionInput: [],
    users: [],
    years: [],
    currentUser: null,
    attendanceSort: { col: null, asc: true },
    paymentSort: { col: null, asc: true },
    isAdminAuthenticated: false
};

let financialChartInstance = null;
let activityChartInstance = null;
let adminRevenueChartInstance = null;
let adminVelocityChartInstance = null;
let adminRetentionChartInstance = null;

const ADMIN_PASSWORD = "6769";
const ADMIN_AUTH_KEY = "ufaAdminAuth";
const SESSION_COST = 700; // MVR per session

let adminChartState = {
    activeChart: 'revenue' // 'revenue', 'velocity', or 'retention'
};

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

// --- Admin Authentication ---

function checkAdminAuth() {
    const stored = localStorage.getItem(ADMIN_AUTH_KEY);
    if (stored === ADMIN_PASSWORD) {
        state.isAdminAuthenticated = true;
        return true;
    }
    return false;
}

function setAdminAuth(password) {
    if (password === ADMIN_PASSWORD) {
        localStorage.setItem(ADMIN_AUTH_KEY, password);
        state.isAdminAuthenticated = true;
        return true;
    }
    return false;
}

function clearAdminAuth() {
    localStorage.removeItem(ADMIN_AUTH_KEY);
    state.isAdminAuthenticated = false;
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

// --- Admin Metrics Calculations ---

function calculateAdminMetrics(chartTimePeriod = 90, chartBinning = 'weekly') {
    const metrics = {};
    metrics.chartTimePeriod = chartTimePeriod;
    metrics.chartBinning = chartBinning;

    // 1. Total Outstanding Receivables (sum of all pending)
    metrics.totalPending = state.summary.reduce((sum, r) => sum + parseMoney(r[SUM.PENDING]), 0);

    // 2. Total Prepaid Liability (sum of all prepaid)
    metrics.totalPrepaid = state.summary.reduce((sum, r) => sum + parseMoney(r[SUM.PREPAY]), 0);

    // 3. Operating Cash (Net Liquidity) = Total Player Payments IN - Field Costs (from Session Input)
    // Financial tracking started July 1st, 2024 - only include data from then onwards
    const trackingStartDate = new Date(2024, 6, 1); // July 1, 2024

    // Total Revenue = ALL player payments (ignore classification system)
    // Prepay, PostPay, Adjustment all count as revenue. Field Booking is historical only (abandoned).
    let totalPlayerPaymentsIn = 0;
    let fieldBookingHistorical = 0;

    state.payments.forEach(r => {
        const amount = parseMoney(r[PAY.AMOUNT]);
        const paymentType = (r[PAY.PREPAYMENT] || '').trim().toLowerCase();
        const paymentDate = parseDate(r[PAY.DATE]);

        // Only count payments from tracking start date onwards
        if (!paymentDate || paymentDate < trackingStartDate) return;

        // Field Booking is historical only (abandoned after centralization)
        if (paymentType === 'field booking' || paymentType === 'fieldbooking') {
            fieldBookingHistorical += amount;
        } else {
            // Everything else is player revenue (Prepay, PostPay, Adjustment, etc.)
            totalPlayerPaymentsIn += amount;
        }
    });

    // Field Costs = Sum from Session Input sheet (actual booking costs)
    // Build a map of date -> field cost from Session Input sheet
    const fieldCostMap = {};
    state.sessionInput.forEach(row => {
        const date = row[SESSION.DATE];
        const cost = parseMoney(row[SESSION.FIELD_COST]);
        if (date && cost > 0) {
            fieldCostMap[date] = cost;
        }
    });

    // Calculate total field costs for sessions that happened (from attendance records)
    let totalFieldCosts = 0;
    const uniqueDates = new Set(
        state.attendance
            .map(r => r[ATT.DATE])
            .filter(dateStr => {
                const date = parseDate(dateStr);
                return date && date >= trackingStartDate;
            })
    );

    uniqueDates.forEach(dateStr => {
        // Use actual field cost from Session Input, or default to SESSION_COST (700 MVR)
        const cost = fieldCostMap[dateStr] || SESSION_COST;
        totalFieldCosts += cost;
    });

    metrics.operatingCash = totalPlayerPaymentsIn - totalFieldCosts;
    metrics.totalRevenue = totalPlayerPaymentsIn;
    metrics.fieldCostsPaid = totalFieldCosts;

    // Keep netLiquidity for backward compatibility (same as operatingCash)
    metrics.netLiquidity = metrics.operatingCash;

    console.log(`Field Costs calculation: ${uniqueDates.size} unique sessions × avg ${(totalFieldCosts / uniqueDates.size).toFixed(2)} MVR = ${fmtMoney(totalFieldCosts)}`);

    // 3b. Profit Calculation: Surcharges collected from PAID sessions only
    // We need to calculate: Collected Profit, Pending Profit, Potential Profit
    let collectedProfit = 0;
    let pendingProfit = 0;

    // Debug: Check attendance record structure and surcharge values
    console.log('\n=== Attendance Record Debug (first 3 records) ===');
    const sampleAttendance = state.attendance.slice(0, 3);
    sampleAttendance.forEach((att, idx) => {
        console.log(`Attendance ${idx + 1}:`, {
            Name: att[ATT.NAME],
            Date: att[ATT.DATE],
            Cost: att[ATT.COST],
            Membership: att[ATT.MEMBERSHIP],
            'Surcharge (index 7)': att[ATT.SURCHARGE],
            'Full record length': att.length,
            'All values': att
        });
    });

    // Count non-zero surcharges
    let nonZeroSurcharges = 0;
    let totalSurchargeSum = 0;
    state.attendance.forEach(r => {
        const surcharge = parseMoney(r[ATT.SURCHARGE] || 0);
        if (surcharge > 0) {
            nonZeroSurcharges++;
            totalSurchargeSum += surcharge;
        }
    });
    console.log(`\n=== Surcharge Summary ===`);
    console.log(`Total attendance records: ${state.attendance.length}`);
    console.log(`Records with non-zero surcharge: ${nonZeroSurcharges}`);
    console.log(`Total surcharges in attendance: ${fmtMoney(totalSurchargeSum)}`);

    // For each user, get their financial ledger and calculate surcharges
    state.users.forEach(userName => {
        const ledger = calculateFinancialLedger(userName);

        // For each session in the ledger, find the attendance record and get surcharge
        ledger.sessions.forEach(session => {
            // Find the matching attendance record(s) for this session
            const attendanceRecords = state.attendance.filter(r =>
                r[ATT.NAME] === userName &&
                r[ATT.DATE] === session.dateStr
            );

            // Sum up surcharges for this session (handles multiple records on same date if any)
            let sessionSurcharge = 0;
            attendanceRecords.forEach(attRec => {
                const surcharge = parseMoney(attRec[ATT.SURCHARGE] || 0);
                sessionSurcharge += surcharge;
            });

            // Add to appropriate profit bucket based on payment status
            if (session.status === 'paid') {
                collectedProfit += sessionSurcharge;
            } else if (session.status === 'unpaid' || session.status === 'partial') {
                pendingProfit += sessionSurcharge;
            }
        });
    });

    console.log(`\n=== Profit Calculation Results ===`);
    console.log(`Collected Profit (from paid sessions): ${fmtMoney(collectedProfit)}`);
    console.log(`Pending Profit (from unpaid/partial sessions): ${fmtMoney(pendingProfit)}`);

    metrics.collectedProfit = collectedProfit;
    metrics.pendingProfit = pendingProfit;
    metrics.potentialProfit = collectedProfit + pendingProfit;

    // Keep totalProfit for backward compatibility (use collectedProfit as the main metric)
    metrics.totalProfit = metrics.collectedProfit;

    // 4. Active Players (attended in last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const activePlayers = new Set();
    state.attendance.forEach(r => {
        const date = parseDate(r[ATT.DATE]);
        if (date && date >= thirtyDaysAgo) {
            activePlayers.add(r[ATT.NAME]);
        }
    });
    metrics.activePlayers = activePlayers.size;

    // 5. Average Attendance per Session
    const sessionDates = [...new Set(state.attendance.map(r => r[ATT.DATE]))];
    metrics.avgAttendance = sessionDates.length > 0
        ? (state.attendance.length / sessionDates.length).toFixed(1)
        : 0;

    // 6. Player Retention Rate (last 30 days vs previous 30 days)
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    const previousPeriodPlayers = new Set();
    state.attendance.forEach(r => {
        const date = parseDate(r[ATT.DATE]);
        if (date && date >= sixtyDaysAgo && date < thirtyDaysAgo) {
            previousPeriodPlayers.add(r[ATT.NAME]);
        }
    });

    if (previousPeriodPlayers.size > 0) {
        const retainedCount = [...previousPeriodPlayers].filter(p => activePlayers.has(p)).length;
        metrics.retentionRate = ((retainedCount / previousPeriodPlayers.size) * 100).toFixed(0);
    } else {
        metrics.retentionRate = 0;
    }

    // 7. Payment Velocity (avg days between session and payment)
    let totalDays = 0;
    let paidSessionCount = 0;

    state.users.forEach(userName => {
        const userAttendance = state.attendance.filter(r => r[ATT.NAME] === userName);
        const userPayments = state.payments.filter(r => r[PAY.NAME] === userName);

        userAttendance.forEach(att => {
            const attDate = parseDate(att[ATT.DATE]);
            if (!attDate) return;

            // Find first payment after this session
            const nextPayment = userPayments.find(pay => {
                const payDate = parseDate(pay[PAY.DATE]);
                return payDate && payDate >= attDate;
            });

            if (nextPayment) {
                const payDate = parseDate(nextPayment[PAY.DATE]);
                const daysDiff = Math.floor((payDate - attDate) / (1000 * 60 * 60 * 24));
                totalDays += daysDiff;
                paidSessionCount++;
            }
        });
    });

    metrics.paymentVelocity = paidSessionCount > 0
        ? Math.round(totalDays / paidSessionCount)
        : 0;

    // 8. Top 10 Debtors
    const debtors = state.summary
        .map(r => ({
            name: r[SUM.NAME],
            pending: parseMoney(r[SUM.PENDING])
        }))
        .filter(d => d.pending > 0)
        .sort((a, b) => b.pending - a.pending)
        .slice(0, 10);
    metrics.topDebtors = debtors;

    // 9. New Player Acquisition (first-time players this month)
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const newPlayersThisMonth = new Set();

    state.users.forEach(userName => {
        const userSessions = state.attendance
            .filter(r => r[ATT.NAME] === userName)
            .map(r => ({ date: parseDate(r[ATT.DATE]), dateStr: r[ATT.DATE] }))
            .filter(s => s.date)
            .sort((a, b) => a.date - b.date);

        if (userSessions.length > 0) {
            const firstSession = userSessions[0].date;
            if (firstSession.getMonth() === currentMonth && firstSession.getFullYear() === currentYear) {
                newPlayersThisMonth.add(userName);
            }
        }
    });
    metrics.newPlayers = newPlayersThisMonth.size;

    // 10. Revenue Trend (this week vs last week)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

    let thisWeekRevenue = 0;
    let lastWeekRevenue = 0;

    state.payments.forEach(r => {
        const payDate = parseDate(r[PAY.DATE]);
        if (!payDate) return;
        const amount = parseMoney(r[PAY.AMOUNT]);

        if (payDate >= sevenDaysAgo) {
            thisWeekRevenue += amount;
        } else if (payDate >= fourteenDaysAgo && payDate < sevenDaysAgo) {
            lastWeekRevenue += amount;
        }
    });

    if (lastWeekRevenue > 0) {
        const percentChange = ((thisWeekRevenue - lastWeekRevenue) / lastWeekRevenue * 100).toFixed(0);
        metrics.revenueTrend = percentChange >= 0 ? `+${percentChange}%` : `${percentChange}%`;
    } else {
        metrics.revenueTrend = thisWeekRevenue > 0 ? "+100%" : "--";
    }

    // 11. Dynamic revenue and attendance data for chart
    const chartData = calculateChartData(chartTimePeriod, chartBinning);
    metrics.chartLabels = chartData.labels;
    metrics.chartRevenue = chartData.revenue;
    metrics.chartAttendance = chartData.attendance;

    return metrics;
}

function validateAdminMetrics(metrics) {
    console.log('=== Financial Metrics Validation ===');

    const trackingStartDate = new Date(2024, 6, 1); // July 1, 2024

    // Count payments by type for detailed breakdown
    let prepayCount = 0, prepaySum = 0;
    let postpayCount = 0, postpaySum = 0;
    let adjustmentCount = 0, adjustmentSum = 0;
    let fieldBookingCount = 0, fieldBookingSum = 0;
    let otherCount = 0, otherSum = 0;

    state.payments.forEach(r => {
        const amount = parseMoney(r[PAY.AMOUNT]);
        const paymentType = (r[PAY.PREPAYMENT] || '').trim();
        const paymentTypeLower = paymentType.toLowerCase();
        const paymentDate = parseDate(r[PAY.DATE]);

        // Only count payments from tracking start date onwards
        if (!paymentDate || paymentDate < trackingStartDate) return;

        if (paymentTypeLower === 'prepay') {
            prepayCount++;
            prepaySum += amount;
        } else if (paymentTypeLower === 'postpay') {
            postpayCount++;
            postpaySum += amount;
        } else if (paymentTypeLower === 'adjustment') {
            adjustmentCount++;
            adjustmentSum += amount;
        } else if (paymentTypeLower === 'field booking' || paymentTypeLower === 'fieldbooking') {
            fieldBookingCount++;
            fieldBookingSum += amount;
        } else {
            otherCount++;
            otherSum += amount;
            if (amount > 0) {
                console.log(`⚠️ Unknown payment type: "${paymentType}", Amount=${fmtMoney(amount)}`);
            }
        }
    });

    console.log('\n=== Payment Breakdown (since July 1, 2024) ===');
    console.log(`Prepay:             ${prepayCount} payments = ${fmtMoney(prepaySum)}`);
    console.log(`PostPay:            ${postpayCount} payments = ${fmtMoney(postpaySum)}`);
    console.log(`Adjustment:         ${adjustmentCount} payments = ${fmtMoney(adjustmentSum)}`);
    console.log(`Field Booking:      ${fieldBookingCount} payments = ${fmtMoney(fieldBookingSum)} (historical, abandoned)`);
    if (otherCount > 0) {
        console.log(`Other/Unknown:      ${otherCount} payments = ${fmtMoney(otherSum)}`);
    }
    console.log(`─────────────────────────────────────────────────────`);
    console.log(`Total Player Revenue: ${fmtMoney(prepaySum + postpaySum + adjustmentSum)}`);
    console.log(`(All payments except historical Field Booking)`);

    // Count sessions and field costs
    const uniqueDates = new Set(
        state.attendance
            .map(r => r[ATT.DATE])
            .filter(dateStr => {
                const date = parseDate(dateStr);
                return date && date >= trackingStartDate;
            })
    );
    console.log(`\n=== Field Costs (from Session Input) ===`);
    console.log(`Total Sessions: ${uniqueDates.size} sessions`);
    console.log(`Avg Cost per Session: ${fmtMoney(metrics.fieldCostsPaid / uniqueDates.size)}`);
    console.log(`Total Field Costs: ${fmtMoney(metrics.fieldCostsPaid)}`);

    // Validation 1: Operating Cash Formula
    const expectedOperatingCash = metrics.totalRevenue - metrics.fieldCostsPaid;
    const operatingCashDiff = Math.abs(metrics.operatingCash - expectedOperatingCash);
    console.log(`\n=== Operating Cash Validation ===`);
    console.log(`Operating Cash: ${fmtMoney(metrics.operatingCash)}`);
    console.log(`  = Total Revenue (${fmtMoney(metrics.totalRevenue)}) - Field Costs (${fmtMoney(metrics.fieldCostsPaid)})`);
    console.log(`  Expected: ${fmtMoney(expectedOperatingCash)}, Diff: ${fmtMoney(operatingCashDiff)}`);
    if (operatingCashDiff > 0.01) {
        console.warn('⚠️ Operating Cash does not balance!');
    } else {
        console.log('✓ Operating Cash balances correctly');
    }

    // Show if operating at profit or loss
    if (metrics.operatingCash > 0) {
        console.log(`✓ Operating with surplus: ${fmtMoney(metrics.operatingCash)}`);
    } else if (metrics.operatingCash < 0) {
        console.log(`⚠️ Operating at deficit: ${fmtMoney(Math.abs(metrics.operatingCash))}`);
    } else {
        console.log(`Operating at break-even`);
    }

    // Validation 2: Profit Formula
    const expectedPotentialProfit = metrics.collectedProfit + metrics.pendingProfit;
    const profitDiff = Math.abs(metrics.potentialProfit - expectedPotentialProfit);
    console.log(`\nPotential Profit: ${fmtMoney(metrics.potentialProfit)}`);
    console.log(`  = Collected Profit (${fmtMoney(metrics.collectedProfit)}) + Pending Profit (${fmtMoney(metrics.pendingProfit)})`);
    console.log(`  Expected: ${fmtMoney(expectedPotentialProfit)}, Diff: ${fmtMoney(profitDiff)}`);
    if (profitDiff > 0.01) {
        console.warn('⚠️ Potential Profit does not balance!');
    } else {
        console.log('✓ Potential Profit balances correctly');
    }

    // Validation 3: Sanity Checks
    console.log('\n=== Sanity Checks ===');
    console.log(`Operating Cash > 0: ${metrics.operatingCash > 0 ? '✓' : '✗'} (${fmtMoney(metrics.operatingCash)})`);
    console.log(`Operating Cash < Total Revenue: ${metrics.operatingCash < metrics.totalRevenue ? '✓' : '✗'}`);
    console.log(`Collected Profit >= 0: ${metrics.collectedProfit >= 0 ? '✓' : '✗'} (${fmtMoney(metrics.collectedProfit)})`);
    console.log(`Collected Profit < Operating Cash: ${metrics.collectedProfit < metrics.operatingCash ? '✓' : '✗'}`);

    // Show sample payment records to verify column structure
    console.log('\n=== Sample Payment Records (first 3) ===');
    const samplePayments = state.payments.slice(0, 3);
    samplePayments.forEach((p, idx) => {
        console.log(`Payment ${idx + 1}:`, {
            Date: p[PAY.DATE],
            Name: p[PAY.NAME],
            Amount: p[PAY.AMOUNT],
            PaymentType: p[PAY.PREPAYMENT],
            Reference: p[PAY.REFERENCE]
        });
    });

    // Log all key metrics for review
    console.log('\n=== Financial Summary ===');
    console.log(`Total Revenue: ${fmtMoney(metrics.totalRevenue)}`);
    console.log(`Field Costs Paid: ${fmtMoney(metrics.fieldCostsPaid)}`);
    console.log(`Operating Cash: ${fmtMoney(metrics.operatingCash)}`);
    console.log(`Collected Profit: ${fmtMoney(metrics.collectedProfit)}`);
    console.log(`Pending Profit: ${fmtMoney(metrics.pendingProfit)}`);
    console.log(`Potential Profit: ${fmtMoney(metrics.potentialProfit)}`);
    console.log('=====================================\n');
}

function calculateChartData(timePeriod, binning) {
    const now = new Date();
    const labels = [];
    const revenue = [];
    const attendance = [];

    // Calculate start date
    let startDate;
    if (timePeriod === 'all') {
        // Find earliest date in attendance or payments
        const allDates = [
            ...state.attendance.map(r => parseDate(r[ATT.DATE])),
            ...state.payments.map(r => parseDate(r[PAY.DATE]))
        ].filter(d => d).sort((a, b) => a - b);

        startDate = allDates.length > 0 ? allDates[0] : new Date();
    } else {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(timePeriod));
    }

    // Generate time buckets based on binning
    const buckets = [];

    if (binning === 'daily') {
        const currentDate = new Date(startDate);
        while (currentDate <= now) {
            buckets.push({
                start: new Date(currentDate),
                end: new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 23, 59, 59),
                label: `${currentDate.getDate()}/${currentDate.getMonth() + 1}`
            });
            currentDate.setDate(currentDate.getDate() + 1);
        }
    } else if (binning === 'weekly') {
        const currentDate = new Date(startDate);
        while (currentDate <= now) {
            const weekEnd = new Date(currentDate);
            weekEnd.setDate(weekEnd.getDate() + 6);
            buckets.push({
                start: new Date(currentDate),
                end: weekEnd > now ? now : weekEnd,
                label: `${currentDate.getDate()}/${currentDate.getMonth() + 1}`
            });
            currentDate.setDate(currentDate.getDate() + 7);
        }
    } else if (binning === 'monthly') {
        const currentDate = new Date(startDate);
        while (currentDate <= now) {
            const monthEnd = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59);
            buckets.push({
                start: new Date(currentDate),
                end: monthEnd > now ? now : monthEnd,
                label: `${SHORT_MONTHS[currentDate.getMonth()]} ${String(currentDate.getFullYear()).slice(2)}`
            });
            currentDate.setMonth(currentDate.getMonth() + 1);
            currentDate.setDate(1);
        }
    }

    // Aggregate data into buckets
    buckets.forEach(bucket => {
        let bucketRevenue = 0;
        let bucketAttendance = 0;

        // Sum revenue for this bucket
        state.payments.forEach(r => {
            const payDate = parseDate(r[PAY.DATE]);
            if (payDate && payDate >= bucket.start && payDate <= bucket.end) {
                bucketRevenue += parseMoney(r[PAY.AMOUNT]);
            }
        });

        // Count attendance for this bucket
        state.attendance.forEach(r => {
            const attDate = parseDate(r[ATT.DATE]);
            if (attDate && attDate >= bucket.start && attDate <= bucket.end) {
                bucketAttendance++;
            }
        });

        labels.push(bucket.label);
        revenue.push(bucketRevenue);
        attendance.push(bucketAttendance);
    });

    return { labels, revenue, attendance };
}

function calculatePaymentVelocityChartData(timePeriod, binning) {
    const now = new Date();
    const labels = [];
    const velocities = [];

    // Calculate start date
    let startDate;
    if (timePeriod === 'all') {
        const allDates = [
            ...state.attendance.map(r => parseDate(r[ATT.DATE])),
            ...state.payments.map(r => parseDate(r[PAY.DATE]))
        ].filter(d => d).sort((a, b) => a - b);
        startDate = allDates.length > 0 ? allDates[0] : new Date();
    } else {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(timePeriod));
    }

    // Generate time buckets
    const buckets = [];
    if (binning === 'daily') {
        const currentDate = new Date(startDate);
        while (currentDate <= now) {
            buckets.push({
                start: new Date(currentDate),
                end: new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 23, 59, 59),
                label: `${currentDate.getDate()}/${currentDate.getMonth() + 1}`
            });
            currentDate.setDate(currentDate.getDate() + 1);
        }
    } else if (binning === 'weekly') {
        const currentDate = new Date(startDate);
        while (currentDate <= now) {
            const weekEnd = new Date(currentDate);
            weekEnd.setDate(weekEnd.getDate() + 6);
            buckets.push({
                start: new Date(currentDate),
                end: weekEnd > now ? now : weekEnd,
                label: `${currentDate.getDate()}/${currentDate.getMonth() + 1}`
            });
            currentDate.setDate(currentDate.getDate() + 7);
        }
    } else if (binning === 'monthly') {
        const currentDate = new Date(startDate);
        while (currentDate <= now) {
            const monthEnd = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59);
            buckets.push({
                start: new Date(currentDate),
                end: monthEnd > now ? now : monthEnd,
                label: `${SHORT_MONTHS[currentDate.getMonth()]} ${String(currentDate.getFullYear()).slice(2)}`
            });
            currentDate.setMonth(currentDate.getMonth() + 1);
            currentDate.setDate(1);
        }
    }

    // Calculate payment velocity for each bucket
    buckets.forEach(bucket => {
        let totalDays = 0;
        let count = 0;

        // For each session in this bucket, find the payment velocity
        state.attendance.forEach(attRec => {
            const attDate = parseDate(attRec[ATT.DATE]);
            if (!attDate || attDate < bucket.start || attDate > bucket.end) return;

            const userName = attRec[ATT.NAME];
            const userPayments = state.payments.filter(p => p[PAY.NAME] === userName);

            // Find first payment after this session
            const nextPayment = userPayments.find(pay => {
                const payDate = parseDate(pay[PAY.DATE]);
                return payDate && payDate >= attDate;
            });

            if (nextPayment) {
                const payDate = parseDate(nextPayment[PAY.DATE]);
                const daysDiff = Math.floor((payDate - attDate) / (1000 * 60 * 60 * 24));
                totalDays += daysDiff;
                count++;
            }
        });

        labels.push(bucket.label);
        velocities.push(count > 0 ? Math.round(totalDays / count) : null);
    });

    return { labels, velocities };
}

function calculateRetentionRateChartData(timePeriod, binning) {
    const now = new Date();
    const labels = [];
    const retentionRates = [];

    // Calculate start date
    let startDate;
    if (timePeriod === 'all') {
        const allDates = state.attendance.map(r => parseDate(r[ATT.DATE])).filter(d => d).sort((a, b) => a - b);
        startDate = allDates.length > 0 ? allDates[0] : new Date();
    } else {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - parseInt(timePeriod));
    }

    // Generate time buckets
    const buckets = [];
    if (binning === 'daily') {
        const currentDate = new Date(startDate);
        while (currentDate <= now) {
            buckets.push({
                start: new Date(currentDate),
                end: new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 23, 59, 59),
                label: `${currentDate.getDate()}/${currentDate.getMonth() + 1}`
            });
            currentDate.setDate(currentDate.getDate() + 1);
        }
    } else if (binning === 'weekly') {
        const currentDate = new Date(startDate);
        while (currentDate <= now) {
            const weekEnd = new Date(currentDate);
            weekEnd.setDate(weekEnd.getDate() + 6);
            buckets.push({
                start: new Date(currentDate),
                end: weekEnd > now ? now : weekEnd,
                label: `${currentDate.getDate()}/${currentDate.getMonth() + 1}`
            });
            currentDate.setDate(currentDate.getDate() + 7);
        }
    } else if (binning === 'monthly') {
        const currentDate = new Date(startDate);
        while (currentDate <= now) {
            const monthEnd = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59);
            buckets.push({
                start: new Date(currentDate),
                end: monthEnd > now ? now : monthEnd,
                label: `${SHORT_MONTHS[currentDate.getMonth()]} ${String(currentDate.getFullYear()).slice(2)}`
            });
            currentDate.setMonth(currentDate.getMonth() + 1);
            currentDate.setDate(1);
        }
    }

    // Calculate retention rate for each bucket
    for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        const prevBucket = i > 0 ? buckets[i - 1] : null;

        if (!prevBucket) {
            labels.push(bucket.label);
            retentionRates.push(null); // No previous period to compare
            continue;
        }

        // Get players from previous bucket
        const prevPlayers = new Set();
        state.attendance.forEach(r => {
            const attDate = parseDate(r[ATT.DATE]);
            if (attDate && attDate >= prevBucket.start && attDate <= prevBucket.end) {
                prevPlayers.add(r[ATT.NAME]);
            }
        });

        // Get players from current bucket
        const currPlayers = new Set();
        state.attendance.forEach(r => {
            const attDate = parseDate(r[ATT.DATE]);
            if (attDate && attDate >= bucket.start && attDate <= bucket.end) {
                currPlayers.add(r[ATT.NAME]);
            }
        });

        // Calculate retention
        if (prevPlayers.size > 0) {
            const retained = [...prevPlayers].filter(p => currPlayers.has(p)).length;
            const retentionRate = (retained / prevPlayers.size) * 100;
            labels.push(bucket.label);
            retentionRates.push(Math.round(retentionRate));
        } else {
            labels.push(bucket.label);
            retentionRates.push(null);
        }
    }

    return { labels, retentionRates };
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
        const [summaryRes, attendanceRes, paymentsRes, sessionInputRes] = await Promise.all([
            fetchWithRetry(`${CONFIG.baseUrl}/${CONFIG.sheetID}/values/Summary Sheet?key=${CONFIG.apiKey}`),
            fetchWithRetry(`${CONFIG.baseUrl}/${CONFIG.sheetID}/values/PivotAttendance?key=${CONFIG.apiKey}`),
            fetchWithRetry(`${CONFIG.baseUrl}/${CONFIG.sheetID}/values/Payments?key=${CONFIG.apiKey}`),
            fetchWithRetry(`${CONFIG.baseUrl}/${CONFIG.sheetID}/values/Session Input?key=${CONFIG.apiKey}`)
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
        const rawSessionInput = (sessionInputRes.values || []).slice(1);

        console.log(`Raw data counts - Summary: ${rawSummary.length}, Attendance: ${rawAttendance.length}, Payments: ${rawPayments.length}, SessionInput: ${rawSessionInput.length}`);

        // Filter out completely empty rows, but be lenient with column count
        state.summary = rawSummary.filter(row => row && row.length > 0 && row[SUM.NAME]);
        state.attendance = rawAttendance.filter(row => row && row.length > 0 && row[ATT.NAME]);
        state.payments = rawPayments.filter(row => row && row.length > 0);
        state.sessionInput = rawSessionInput.filter(row => row && row.length > 0 && row[SESSION.DATE]);
        state.users = [...new Set(state.summary.map(r => r[SUM.NAME]))].filter(Boolean).sort();

        console.log(`Filtered data counts - Summary: ${state.summary.length}, Attendance: ${state.attendance.length}, Payments: ${state.payments.length}, SessionInput: ${state.sessionInput.length}`);

        if (state.summary.length === 0 || state.attendance.length === 0) {
            throw new Error(`No valid data found. Summary: ${state.summary.length} rows, Attendance: ${state.attendance.length} rows`);
        }

        // Use current date for "Updated" timestamp (removed API call to avoid quota issues)
        const lastUpdate = new Date().toLocaleDateString();
        $('#lastUpdated').text(`Updated ${lastUpdate}`);

        populateFilters();
        setupEventListeners();

        // Check admin auth on page load
        checkAdminAuth();

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

    // Payment markers only on "Total Paid" line (stars for payments, circles for costs)
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
                    pointStyle: 'circle',
                    pointRadius: 2,
                    pointBackgroundColor: 'rgb(239, 83, 80)',
                    pointBorderColor: 'rgb(239, 83, 80)',
                    pointHoverRadius: 6,
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

// --- Admin Dashboard ---

function renderAdminDashboard() {
    $('#welcomeMessage').hide();
    $('#userDashboard').hide();
    $('#adminPanel').show();

    // Get chart settings from dropdowns (default to 90 days, weekly if not set)
    const chartTimePeriod = $('#revenueTimePeriod').val() || '90';
    const chartBinning = $('#revenueBinning').val() || 'weekly';

    const metrics = calculateAdminMetrics(chartTimePeriod, chartBinning);

    // Validate metrics (logs to console)
    validateAdminMetrics(metrics);

    // Top row tiles
    $('#adminTotalPending').text(fmtMoney(metrics.totalPending));
    $('#adminTotalPrepaid').text(fmtMoney(metrics.totalPrepaid));
    $('#adminActivePlayers').text(metrics.activePlayers);
    $('#adminTotalProfit').text(fmtMoney(metrics.collectedProfit)); // Changed to collectedProfit

    // Additional metrics
    $('#adminOperatingCash').text(fmtMoney(metrics.operatingCash));
    $('#adminAvgAttendance').text(metrics.avgAttendance);
    $('#adminPaymentVelocity').text(`${metrics.paymentVelocity} days`);
    $('#adminRetentionRate').text(`${metrics.retentionRate}%`);
    $('#adminNewPlayers').text(metrics.newPlayers);
    $('#adminRevenueTrend').text(metrics.revenueTrend);
    $('#adminPendingProfit').text(fmtMoney(metrics.pendingProfit));
    $('#adminPotentialProfit').text(fmtMoney(metrics.potentialProfit));
    $('#adminTotalRevenue').text(fmtMoney(metrics.totalRevenue));
    $('#adminFieldCostsPaid').text(fmtMoney(metrics.fieldCostsPaid));

    // Top 10 Debtors List
    const debtorsHtml = metrics.topDebtors.length > 0
        ? metrics.topDebtors.map((d, idx) => `
            <div class="debtor-item">
                <div class="debtor-rank">${idx + 1}</div>
                <div class="debtor-name">
                    <a href="#" class="text-link user-link" data-name="${d.name}">${d.name}</a>
                </div>
                <div class="debtor-amount">${fmtMoney(d.pending)}</div>
            </div>
        `).join('')
        : '<div style="color: #888; text-align: center; padding: 20px;">No pending payments</div>';

    $('#adminTopDebtors').html(debtorsHtml);

    // Render all charts (only the active one will be visible)
    renderAdminRevenueChart(metrics);
    renderAdminVelocityChart(chartTimePeriod, chartBinning);
    renderAdminRetentionChart(chartTimePeriod, chartBinning);

    // Render the "All Data" table within admin panel
    renderAllPayments();
}

function renderAdminRevenueChart(metrics) {
    const ctx = document.getElementById('adminRevenueChart').getContext('2d');

    if (adminRevenueChartInstance) adminRevenueChartInstance.destroy();

    const labels = metrics.chartLabels;
    const revenueData = metrics.chartRevenue;
    const attendanceData = metrics.chartAttendance;

    // Determine label based on binning
    const binningLabel = metrics.chartBinning === 'daily' ? 'Daily' :
                        metrics.chartBinning === 'weekly' ? 'Weekly' : 'Monthly';

    adminRevenueChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    type: 'bar',
                    label: `${binningLabel} Revenue (MVR)`,
                    data: revenueData,
                    backgroundColor: 'rgba(76, 175, 80, 0.6)',
                    borderColor: 'rgba(76, 175, 80, 1)',
                    borderWidth: 1,
                    yAxisID: 'y',
                    borderRadius: 4
                },
                {
                    type: 'line',
                    label: `${binningLabel} Attendance`,
                    data: attendanceData,
                    borderColor: 'rgba(72, 141, 170, 1)',
                    backgroundColor: 'rgba(72, 141, 170, 0.1)',
                    borderWidth: 2,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    yAxisID: 'y1',
                    tension: 0.3
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
                    title: {
                        display: true,
                        text: 'Revenue (MVR)'
                    },
                    ticks: {
                        callback: function(value) {
                            return value + ' MVR';
                        }
                    }
                },
                y1: {
                    type: 'linear',
                    position: 'right',
                    beginAtZero: true,
                    grid: {
                        drawOnChartArea: false
                    },
                    title: {
                        display: true,
                        text: 'Attendance'
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top'
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.dataset.label || '';
                            const value = context.parsed.y;
                            if (label.includes('Revenue')) {
                                return ` ${label}: ${value.toFixed(2)} MVR`;
                            }
                            return ` ${label}: ${value}`;
                        }
                    }
                }
            }
        }
    });
}

function renderAdminVelocityChart(timePeriod, binning) {
    const ctx = document.getElementById('adminVelocityChart').getContext('2d');

    if (adminVelocityChartInstance) adminVelocityChartInstance.destroy();

    const chartData = calculatePaymentVelocityChartData(timePeriod, binning);
    const labels = chartData.labels;
    const velocities = chartData.velocities;

    const binningLabel = binning === 'daily' ? 'Daily' : binning === 'weekly' ? 'Weekly' : 'Monthly';

    adminVelocityChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: `${binningLabel} Payment Velocity (Days)`,
                    data: velocities,
                    borderColor: 'rgba(255, 152, 0, 1)',
                    backgroundColor: 'rgba(255, 152, 0, 0.1)',
                    borderWidth: 3,
                    pointRadius: 5,
                    pointHoverRadius: 7,
                    pointBackgroundColor: 'rgba(255, 152, 0, 1)',
                    tension: 0.3,
                    spanGaps: true
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
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: 'Days'
                    },
                    ticks: {
                        callback: function(value) {
                            return Math.round(value) + ' days';
                        }
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top'
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const value = context.parsed.y;
                            return ` Average: ${value !== null ? Math.round(value) + ' days' : 'No data'}`;
                        }
                    }
                }
            }
        }
    });
}

function renderAdminRetentionChart(timePeriod, binning) {
    const ctx = document.getElementById('adminRetentionChart').getContext('2d');

    if (adminRetentionChartInstance) adminRetentionChartInstance.destroy();

    const chartData = calculateRetentionRateChartData(timePeriod, binning);
    const labels = chartData.labels;
    const retentionRates = chartData.retentionRates;

    const binningLabel = binning === 'daily' ? 'Daily' : binning === 'weekly' ? 'Weekly' : 'Monthly';

    adminRetentionChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: `${binningLabel} Retention Rate (%)`,
                    data: retentionRates,
                    borderColor: 'rgba(156, 39, 176, 1)',
                    backgroundColor: 'rgba(156, 39, 176, 0.1)',
                    borderWidth: 3,
                    pointRadius: 5,
                    pointHoverRadius: 7,
                    pointBackgroundColor: 'rgba(156, 39, 176, 1)',
                    tension: 0.3,
                    spanGaps: true,
                    fill: true
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
                    beginAtZero: true,
                    max: 100,
                    title: {
                        display: true,
                        text: 'Retention Rate (%)'
                    },
                    ticks: {
                        callback: function(value) {
                            return value + '%';
                        }
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top'
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const value = context.parsed.y;
                            return ` Retention: ${value !== null ? value + '%' : 'No data'}`;
                        }
                    }
                }
            }
        }
    });
}

function showAdminPanel() {
    if (!checkAdminAuth()) {
        // Show password modal
        $('#adminPasswordModal').css('display', 'flex');
        $('#adminPasswordError').hide();
        $('#adminPasswordInput').val('');
        setTimeout(() => $('#adminPasswordInput').el?.focus(), 100);
    } else {
        // Already authenticated, show admin panel
        renderAdminDashboard();
    }
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

    $('#showAdminPanel').click(() => {
        showAdminPanel();
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

    // Admin password modal
    $('.close-admin-modal').on('click', () => {
        $('#adminPasswordModal').hide();
        $('#adminPasswordError').hide();
        $('#adminPasswordInput').val('');
    });

    $('#adminPasswordSubmit').click(() => {
        const password = $('#adminPasswordInput').val();
        if (setAdminAuth(password)) {
            $('#adminPasswordModal').hide();
            $('#adminPasswordError').hide();
            $('#adminPasswordInput').val('');
            renderAdminDashboard();
        } else {
            $('#adminPasswordError').show();
            $('#adminPasswordInput').val('');
            setTimeout(() => $('#adminPasswordInput').el?.focus(), 100);
        }
    });

    // Allow Enter key to submit password
    $('#adminPasswordInput').on('keypress', (e) => {
        if (e.key === 'Enter') {
            $('#adminPasswordSubmit').el?.click();
        }
    });

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

    // Admin chart controls
    $('#revenueTimePeriod, #revenueBinning').on('change', () => {
        if (state.isAdminAuthenticated && $('#adminPanel').css('display') !== 'none') {
            renderAdminDashboard();
        }
    });

    // Admin chart tabs
    $('.admin-chart-tab').click(function() {
        const chartType = this.getAttribute('data-chart');
        adminChartState.activeChart = chartType;

        // Update tab active states
        $('.admin-chart-tab').removeClass('active');
        $(this).addClass('active');

        // Show/hide chart containers
        $('.admin-chart-container').hide();
        if (chartType === 'revenue') {
            $('#revenueChartContainer').show();
        } else if (chartType === 'velocity') {
            $('#velocityChartContainer').show();
        } else if (chartType === 'retention') {
            $('#retentionChartContainer').show();
        }
    });
}

document.addEventListener('DOMContentLoaded', initApp);
window.selectUser = selectUser;
