// ==UserScript==
// @name Steam Card Exchange Tools
// @namespace Steam Card Exchange Tools
// @author Laurvin
// @description A set of tools to make using SCE easier. Adds a Set Worth column to both pages, adds trade buttons to trade directly from the table, a Sync button to synchronize the Watchlist with your actual owned cards, a Booster Pack value calculator on the Inventory page, and it auto-populates Steam Trade Offers made via the buttons. Note that you need to be logged into the Steam Community page for most of it to work and you need to be logged into the Steam Store for Booster Value calculation to work. Steam usually only let's you stay logged in for about 24 hours if you don't visit the site.
// @version 13.3
// @icon https://i.imgur.com/XYzKXzK.png
// @downloadURL https://github.com/Laurvin/Steam-Card-Exchange-Tools/raw/master/Steam_Card_Exchange_Tools.user.js
// @updateURL https://github.com/Laurvin/Steam-Card-Exchange-Tools/raw/master/Steam_Card_Exchange_Tools.user.js
// @match https://www.steamcardexchange.net/index.php?userlist
// @match http://www.steamcardexchange.net/index.php?userlist
// @match https://www.steamcardexchange.net/index.php?inventory
// @match http://www.steamcardexchange.net/index.php?inventory
// @match https://steamcommunity.com/tradeoffer/new/*
// @match http://steamcommunity.com/tradeoffer/new/*
// @grant GM_xmlhttpRequest
// @grant GM_openInTab
// @grant GM_setValue
// @grant GM_getValue
// @grant GM_deleteValue
// @grant GM_listValues
// @grant unsafeWindow
// @connect steamcommunity.com
// @connect store.steampowered.com
// @run-at document-idle
// ==/UserScript==

/* globals jQuery, $ */

(function () {
    'use strict';

    // =========================================================================
    // PAGE DETECTION
    // =========================================================================

    const IS_TRADE_PAGE = window.location.hostname === 'steamcommunity.com';
    const IS_WATCHLIST = !IS_TRADE_PAGE && window.location.href.includes('userlist');
    const TABLE_ID = IS_WATCHLIST ? 'private_watchlist' : 'inventorylist';

    // Script version shown in the status bar and the SCE toolbar button.
    const SCRIPT_VERSION = '13.3';

    // GM storage key a trade tab writes to (refreshed every ~250ms) while it's
    // actively waiting on Steam inventories to load. The SCE Watchlist/
    // Inventory page's precompute queues (B/L and S buttons) check this before
    // each game and pause while it's fresh, since both those queues and a
    // trade page's own inventory loading compete for the same Steam rate-limit
    // budget — running them all at once is what was causing regular (non-
    // Quick-Trade) trades to fail with sustained 429s.
    const TRADE_LOADING_HEARTBEAT_KEY = 'sce_trade_loading';
    const TRADE_LOADING_HEARTBEAT_FRESH_MS = 5000;

    // Set to false to suppress the blue/red status bar on the Steam trade page.
    const STATUS_BAR_ENABLED = true;

    // Column indices (these are structural and never user-configurable).
    const COL_WORTH = 1;
    const COL_SETSIZE = 3;
    const COL_SW = 4;
    const COL_BTN = 5;
    const COL_SYNCH_START = 6;
    const COL_CN = COL_SYNCH_START + 2; // Cards Needed

    // ── User configuration ─────────────────────────────────────────────────
    // All values are read from GM storage on every page load so they take
    // effect after a reload without reinstalling the script.

    function loadConfig() {
        function intVal(key, def) {
            return Math.max(0, parseInt(GM_getValue(key, String(def)), 10) || def);
        }
        return {
            // Display defaults
            watchlistFilter: GM_getValue('sce_cfg_watchlist_filter', 'all'),   // 'all'|'green'
            watchlistSort:   GM_getValue('sce_cfg_watchlist_sort',   'desc'),  // 'asc'|'desc'
            inventoryFilter: GM_getValue('sce_cfg_inventory_filter', 'green'), // 'all'|'green'
            inventorySort:   GM_getValue('sce_cfg_inventory_sort',   'asc'),   // 'asc'|'desc'
            // Trade button thresholds
            blRange:     intVal('sce_cfg_bl_range',   4), // SW units above cheapest green for B/L buttons
            sCount:      intVal('sce_cfg_s_count',    7), // # of highest-SW games that get an S button
            sBlacklist: (GM_getValue('sce_cfg_s_blacklist', '') || '')
                            .split(',').map(function (s) { return s.trim(); }).filter(Boolean),
            // Trade page opening mode for injection trades (B/L/S).
            // Quick Trades always open as background tabs regardless of this setting.
            tradeOpenMode: GM_getValue('sce_cfg_trade_open_mode', 'tab'), // 'tab'|'window'
            // Whether to use Quick-Trade URLs when the bot supplies them.
            // Set to false to always use the injection method instead.
            useQt: GM_getValue('sce_cfg_use_qt', 'yes') !== 'no',
            // What to do once a trade offer is confirmed sent: 'none' leaves
            // the tab as-is, 'close' closes it (previous default behaviour),
            // 'ok' clicks Steam's own success-modal OK button so the tab
            // navigates to the trade offers recap page instead of closing.
            actionAfterTrade: GM_getValue('sce_cfg_action_after_trade', 'close')
        };
    }

    const CFG = loadConfig();

    // ── GM menu commands ───────────────────────────────────────────────────
    // Appears in the Tampermonkey / Violentmonkey popup when the user clicks
    // the extension icon.  Labels show the CURRENT stored value; clicking
    // saves the new value and prompts for a page reload to apply it.

    // ── Settings modal ──────────────────────────────────────────────────────
    // Replaces the old GM_registerMenuCommand right-click menu (9 separate
    // entries, each opening a prompt()/confirm() dialog) with a single
    // in-page modal opened by clicking the "SCE Tools (vX.X)" button.
    // Styled to match SCE's own dark theme rather than the browser's native
    // dialog chrome.

    const SETTINGS_FIELDS = [
        {
            key: 'sce_cfg_watchlist_filter', label: 'Watchlist \u2013 Default Filter', type: 'select', default: 'all',
            options: [['all', 'All games'], ['green', 'Green only']]
        },
        {
            key: 'sce_cfg_watchlist_sort', label: 'Watchlist \u2013 Default S\u00A0W Sort', type: 'select', default: 'desc',
            options: [['asc', 'Ascending'], ['desc', 'Descending']]
        },
        {
            key: 'sce_cfg_inventory_filter', label: 'Inventory \u2013 Default Filter', type: 'select', default: 'green',
            options: [['all', 'All games'], ['green', 'Green only']]
        },
        {
            key: 'sce_cfg_inventory_sort', label: 'Inventory \u2013 Default S\u00A0W Sort', type: 'select', default: 'asc',
            options: [['asc', 'Ascending'], ['desc', 'Descending']]
        },
        {
            key: 'sce_cfg_bl_range', label: 'B & L Buttons \u2013 range above cheapest Green', type: 'int', default: '4',
            title: 'This number is added to the Set Worth value of the cheapest Green (normal '
                + 'price) game. All games with a value between the cheapest Green game and the '
                + 'number added here will get Buy and Limited Buy buttons.\n\n'
                + 'Keep in mind that each button row will make a call to both a SCE and Steam '
                + 'badge page, and do so at no more than one per second. So do not set this '
                + 'number too high.'
        },
        {
            key: 'sce_cfg_s_count', label: 'S Buttons \u2013 # of highest S\u00A0W games', type: 'int', default: '7',
            title: 'This sets how many Sell buttons will be created. It starts with the game '
                + 'with the highest Set Worth and then descends for the number set here (but if '
                + 'it ends on a game with a Set Worth that is shared with other games, those '
                + 'games get a button as well).\n\n'
                + 'So note that this works differently than the B & L buttons where we look for '
                + 'a Set Worth value, here it\u2019s just a set number of games.'
        },
        {
            key: 'sce_cfg_s_blacklist', label: 'Trade Button Blacklist \u2013 comma-separated AppIDs', type: 'appidlist', default: '',
            title: 'Any games listed here are skipped entirely by the S button, and are also '
                + 'excluded from both the B & L buttons AND from the cheapest-green-game '
                + 'calculation that decides where B & L buttons start (setting above).\n\n'
                + 'Example: if the cheapest green game is at S\u00A0W\u00A040 and it\u2019s blacklisted, '
                + 'the next cheapest green game (e.g. S\u00A0W\u00A045) becomes the new baseline.\n\n'
                + 'You can get the AppID for a game from the SCE game page or the Steam badge '
                + 'page, in both cases it\u2019s the number at the end of the URL.'
        },
        {
            key: 'sce_cfg_trade_open_mode', label: 'Open Regular Trades in', type: 'select', default: 'tab',
            options: [['tab', 'New Tab'], ['window', 'New Window']],
            title: 'The benefit of opening a trade in its own, small window, is that it is '
                + 'always treated as a foreground tab and thus both the trade itself and this '
                + 'script have a better chance to load correctly.\n\n'
                + 'Do note that Steam does seem to throttle you when you make too many trades '
                + 'in too short a time.'
        },
        {
            key: 'sce_cfg_use_qt', label: 'Use Quick-Trades if Possible', type: 'checkbox', default: 'yes',
            title: 'This setting is only for the B and L buttons. Quick-Trades are trades for '
                + 'just one card, which is selected via the trade URL. These are a lot more '
                + 'bulletproof and almost always load successfully (if not, a reload of the '
                + 'trade tab/window usually fixes it).\n\n'
                + 'However, because it can only get one card per trade, Quick-Trades can only '
                + 'work if the cards we are getting contain no duplicates. We then spawn a '
                + 'number of trade tabs (never windows) equal to the number of cards we are '
                + 'getting.'
        },
        {
            key: 'sce_cfg_action_after_trade', label: 'Action after Trade', type: 'select', default: 'close',
            options: [['none', 'Do Nothing'], ['close', 'Close window'], ['ok', 'Click OK']],
            title: 'The script can close the window/tab for you or click the OK button so that '
                + 'Steam loads the Sent Offers page.\n\n'
                + 'Note that if a trade needs confirmation you will need to remember this and '
                + 'confirm it.'
        }
    ];

    function parseNonNegInt(raw) {
        const t = raw.trim();
        const n = parseInt(t, 10);
        return (!isNaN(n) && n >= 0 && String(n) === t) ? n : null;
    }

    function openSettingsModal() {
        if (document.getElementById('sce-settings-overlay')) return; // already open

        const overlay = document.createElement('div');
        overlay.id = 'sce-settings-overlay';

        const panel = document.createElement('div');
        panel.id = 'sce-settings-panel';

        panel.innerHTML =
            '<div id="sce-settings-header">' +
            '<h2>SCE Tools Settings</h2>' +
            '<button type="button" id="sce-settings-close" aria-label="Close">\u2715</button>' +
            '</div>' +
            '<div id="sce-settings-body"></div>';

        const body = panel.querySelector('#sce-settings-body');

        const intro = document.createElement('div');
        intro.id = 'sce-settings-intro';
        // "See the full Read Me on GitHub." will become a link once the Read
        // Me page exists; kept as a separate span now so a href can be added
        // without touching the surrounding text later.
        intro.innerHTML =
            '<p><span id="sce-settings-readme-link">See the full Read Me on GitHub.</span></p>' +
            '<p>Hover over the options below for more information.</p>';
        body.appendChild(intro);

        SETTINGS_FIELDS.forEach(function (field) {
            const row = document.createElement('div');
            row.className = 'sce-settings-row';
            row.dataset.key = field.key;

            const currentValue = GM_getValue(field.key, field.default);
            let input;

            if (field.type === 'select') {
                input = document.createElement('select');
                field.options.forEach(function (opt) {
                    const o = document.createElement('option');
                    o.value = opt[0];
                    o.textContent = opt[1];
                    if (opt[0] === currentValue) o.selected = true;
                    input.appendChild(o);
                });
            } else if (field.type === 'checkbox') {
                input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = currentValue !== 'no';
            } else if (field.type === 'appidlist') {
                // Textarea instead of a plain text input so users with large
                // blacklists can drag the resize handle to see more at once.
                // Starts at the same visual size as the other input boxes.
                input = document.createElement('textarea');
                input.value = currentValue;
                input.rows = 1;
            } else {
                // 'int' renders as a plain text input.
                input = document.createElement('input');
                input.type = 'text';
                input.value = currentValue;
            }
            input.id = 'sce-settings-input-' + field.key;

            const label = document.createElement('label');
            label.htmlFor = input.id;
            label.textContent = field.label;
            if (field.title) label.title = field.title;

            // Labels come before inputs (left column); see CSS grid-template-columns.
            row.appendChild(label);
            row.appendChild(input);
            body.appendChild(row);
        });

        const note = document.createElement('div');
        note.id = 'sce-settings-note';
        note.textContent = 'After clicking Save, reload the page to apply changes (close the tab and open a new '
            + 'one if this doesn\u2019t work properly).';
        body.appendChild(note);

        const footer = document.createElement('div');
        footer.id = 'sce-settings-footer';
        footer.innerHTML =
            '<button type="button" id="sce-settings-cancel">Cancel</button>' +
            '<button type="button" id="sce-settings-save">Save</button>';
        body.appendChild(footer);

        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        function closeModal() { overlay.remove(); }

        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeModal();
        });
        panel.querySelector('#sce-settings-close').addEventListener('click', closeModal);
        panel.querySelector('#sce-settings-cancel').addEventListener('click', closeModal);

        panel.querySelector('#sce-settings-save').addEventListener('click', function () {
            // Clear any previous inline error state before re-validating.
            body.querySelectorAll('.sce-settings-invalid').forEach(function (el) {
                el.classList.remove('sce-settings-invalid');
            });
            body.querySelectorAll('.sce-settings-error').forEach(function (el) { el.remove(); });

            const toSave = {};
            let firstInvalidInput = null;

            for (let i = 0; i < SETTINGS_FIELDS.length; i++) {
                const field = SETTINGS_FIELDS[i];
                const row = body.querySelector('.sce-settings-row[data-key="' + field.key + '"]');
                const input = document.getElementById('sce-settings-input-' + field.key);

                if (field.type === 'select') {
                    toSave[field.key] = input.value;
                } else if (field.type === 'checkbox') {
                    toSave[field.key] = input.checked ? 'yes' : 'no';
                } else if (field.type === 'int') {
                    const n = parseNonNegInt(input.value);
                    if (n === null) {
                        input.classList.add('sce-settings-invalid');
                        const err = document.createElement('div');
                        err.className = 'sce-settings-error';
                        err.textContent = field.label + ': must be a whole number, 0 or higher.';
                        row.after(err);
                        if (!firstInvalidInput) firstInvalidInput = input;
                        continue;
                    }
                    toSave[field.key] = String(n);
                } else if (field.type === 'appidlist') {
                    const trimmed = input.value.trim();
                    if (trimmed === '') {
                        toSave[field.key] = '';
                        continue;
                    }
                    const parts = trimmed.split(',').map(function (s) { return s.trim(); });
                    const bad = parts.filter(function (p) { return !/^\d+$/.test(p); });
                    if (bad.length > 0) {
                        input.classList.add('sce-settings-invalid');
                        const err = document.createElement('div');
                        err.className = 'sce-settings-error';
                        err.textContent = field.label + ': invalid AppID(s) \u2014 ' + bad.join(', ')
                            + ' (numbers only, comma-separated).';
                        row.after(err);
                        if (!firstInvalidInput) firstInvalidInput = input;
                        continue;
                    }
                    toSave[field.key] = parts.join(',');
                }
            }

            if (firstInvalidInput) {
                firstInvalidInput.focus();
                return; // do not save anything until all fields are valid
            }

            Object.keys(toSave).forEach(function (key) {
                GM_setValue(key, toSave[key]);
            });
            closeModal();
        });
    }

    // Applies the desired filter state without blindly toggling.
    function setFilterState(wantGreenOnly) {
        // mode='green': all rows visible (button says "Show Green" = click to filter)
        // mode='all':   only green rows visible (button says "Show All" = click to clear)
        var alreadyGreenOnly = ($('#sce-filter').data('mode') === 'all');
        if (wantGreenOnly !== alreadyGreenOnly) {
            $('#sce-filter').trigger('click');
        }
    }

    // =========================================================================
    // ENTRY POINT
    // =========================================================================

    // @run-at document-idle guarantees the DOM is ready, so we call init()
    // directly instead of via $(document).ready(). This also works on the
    // Steam trade page where jQuery may not be available.
    init();

    async function init() {
        if (IS_TRADE_PAGE) {
            initTradeInjector();
            return;
        }
        console.log('Steam Card Exchange Tools: initialising.');
        cleanupOldTrades();
        injectStyles();
        addToolbarButtons();
        waitForTable(TABLE_ID, onTableReady);
    }

    // =========================================================================
    // STYLES
    // =========================================================================

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            .w-10 { width: 2.5rem; }
            .w-14 { width: 3.5rem; }
            .w-24 { width: 6rem; }
            .needed1 { color: #d30000; }
            .needed2 { color: #f56600; }
            .needed3 { color: #f59e00; }

            /* Version button red state used while table columns are being redrawn. */
            #sce-version.sce-updating {
                background: #b52424 !important;
                background-image: none !important;
                border-color: #8b1a1a !important;
            }

            /* Quick Trade indicator: a tiny raised Q shown after the count.
             * Using ::after + data-qt keeps the button textContent purely numeric
             * ("G: 3") so the button stays narrow, while still giving a visible
             * signal that clicking opens multiple tabs instead of one injected trade. */
            .sce-trade-btn[data-qt]::after {
                content: 'Q';
                font-size: 0.5em;
                vertical-align: super;
                color: #ffd000;
                margin-left: 1px;
            }

            /* L button text colouring when ≤ 3 cards are needed for the next badge.
             * Uses the same colours as the Cards Needed column (needed1/2/3).
             * :not(.yellow) ensures the yellow "not available" state wins. */
            .sce-trade-btn.sce-l-1:not(.yellow) { color: #d30000 !important; }
            .sce-trade-btn.sce-l-2:not(.yellow) { color: #f56600 !important; }
            .sce-trade-btn.sce-l-3:not(.yellow) { color: #f59e00 !important; }

            /* B/L button colour states:
             * - sce-craftable-now: a badge can ALREADY be crafted right now,
             *   with no further trading — bright green. (L button only.)
             * - sce-completes-badge: this SPECIFIC trade would complete a
             *   badge that wasn't craftable before — darker green, so it's
             *   visually distinct from (and one step below) craftable-now.
             * - sce-exceeds-badge-cap: this trade would leave the user
             *   holding more cards than useful for badge level 5 — red.
             *   G/Buy button only; G intentionally keeps buying past what's
             *   needed for remaining badges, this just flags when it does.
             * Placed AFTER sce-l-1/2/3 so its !important text colour wins
             * over the CN-based red/orange/amber text colour.
             * :not(.yellow) as usual — yellow always wins. */
            .sce-trade-btn.sce-craftable-now:not(.yellow) {
                background: #1f9d55 !important;
                background-image: none !important;
                border-color: #16793f !important;
                color: #ffffff !important;
            }
            .sce-trade-btn.sce-completes-badge:not(.yellow):not(.sce-craftable-now) {
                background: #145c33 !important;
                background-image: none !important;
                border-color: #0d3f23 !important;
                color: #ffffff !important;
            }
            .sce-trade-btn.sce-exceeds-badge-cap:not(.yellow) {
                background: #b52424 !important;
                background-image: none !important;
                border-color: #8b1a1a !important;
                color: #ffffff !important;
            }
            #private_watchlist tbody tr > td:nth-child(6),
            #inventorylist tbody tr > td:nth-child(6) {
                white-space: nowrap;
            }

            #private_watchlist tbody tr:hover > td,
            #private_watchlist tbody tr:hover > td > a:not(.sce-trade-btn),
            #inventorylist tbody tr:hover > td,
            #inventorylist tbody tr:hover > td > a:not(.sce-trade-btn) {
                background-color: #1e3a5c !important;
            }

            /* Trade buttons G / M / V */
            .sce-trade-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: fit-content;
                min-width: 1.1rem;
                height: 1.1rem;
                padding: 0 3px;
                font-size: 0.9rem;
                cursor: pointer;
                border-radius: 2px;
                margin-left: 2px;
                color: #ffffff;
                background-color: #033c77;
                background-image: linear-gradient(var(--tw-gradient-stops));
                --tw-gradient-from: var(--color-blue-light);
                --tw-gradient-stops: var(--tw-gradient-via-stops);
                --tw-gradient-to: var(--color-blue-dark);
                text-decoration: none;
                vertical-align: middle;
                user-select: none;
            }
            .sce-trade-btn:hover { opacity: 0.85; }
            .sce-trade-btn.yellow { background-color: #c8a800; background-image: none; }

            /* Dark, inert indicator shown in the T B column for blacklisted
             * games — same size/shape as a trade button but visually distinct
             * (no gradient, no pointer cursor, no click handler) since it's
             * purely informational. */
            .sce-bl-indicator {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: fit-content;
                min-width: 1.1rem;
                height: 1.1rem;
                padding: 0 3px;
                font-size: 0.9rem;
                border-radius: 2px;
                margin-left: 2px;
                color: #8a8f98;
                background-color: #20232a;
                border: 1px solid #3a3f47;
                vertical-align: middle;
                user-select: none;
            }

            /* ── Settings modal ─────────────────────────────────────────── */
            #sce-settings-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.65);
                z-index: 9999;
                display: flex;
                align-items: center;
                justify-content: center;
            }
            #sce-settings-panel {
                background: #15181d;
                border: 1px solid #2a2f38;
                border-radius: 6px;
                width: 720px;
                max-width: 94vw;
                max-height: 90vh;
                overflow-y: auto;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
                font-family: inherit;
                color: #d8dbe0;
            }
            #sce-settings-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 14px 18px;
                border-bottom: 1px solid #2a2f38;
                background: #1b1f27;
                border-radius: 6px 6px 0 0;
            }
            #sce-settings-header h2 {
                margin: 0;
                font-size: 1.15rem;
                font-weight: 700;
                color: #ffffff;
            }
            #sce-settings-close {
                cursor: pointer;
                color: #9aa0aa;
                font-size: 1.3rem;
                line-height: 1;
                background: none;
                border: none;
                padding: 2px 6px;
            }
            #sce-settings-close:hover { color: #ffffff; }
            #sce-settings-body {
                padding: 18px;
                display: grid;
                grid-template-columns: 1fr 1fr;
                column-gap: 28px;
                row-gap: 14px;
            }
            #sce-settings-intro {
                grid-column: 1 / -1;
                font-size: 0.82rem;
                color: #c3c7ce;
                border-bottom: 1px solid #2a2f38;
                padding-bottom: 12px;
                margin-bottom: 2px;
                line-height: 1.4;
            }
            #sce-settings-intro p { margin: 0 0 6px 0; }
            #sce-settings-intro p:last-child { margin-bottom: 0; }
            #sce-settings-readme-link { color: #6cb2ff; }
            .sce-settings-row {
                display: grid;
                grid-template-columns: 1fr 150px;
                align-items: center;
                column-gap: 10px;
            }
            .sce-settings-row label {
                font-size: 0.85rem;
                color: #c3c7ce;
                line-height: 1.25;
            }
            .sce-settings-row input[type="text"],
            .sce-settings-row input[type="number"],
            .sce-settings-row select {
                width: 150px;
                box-sizing: border-box;
                background: #0e1015;
                border: 1px solid #3a4048;
                color: #ffffff;
                border-radius: 3px;
                padding: 5px 7px;
                font-size: 0.85rem;
                justify-self: end;
            }
            .sce-settings-row textarea {
                width: 150px;
                height: 36px;
                min-height: 36px;
                box-sizing: border-box;
                background: #0e1015;
                border: 1px solid #3a4048;
                color: #ffffff;
                border-radius: 3px;
                padding: 5px 7px;
                font-size: 0.85rem;
                font-family: inherit;
                justify-self: end;
                resize: vertical;
            }
            .sce-settings-row input.sce-settings-invalid,
            .sce-settings-row textarea.sce-settings-invalid {
                border-color: #d30000;
                background: #2a1010;
            }
            .sce-settings-row input[type="checkbox"] {
                justify-self: start;
                margin: 0;
                transform: scale(1.2);
            }
            .sce-settings-error {
                grid-column: 1 / -1;
                color: #ff6b6b;
                font-size: 0.75rem;
                margin-top: -8px;
            }
            #sce-settings-note {
                grid-column: 1 / -1;
                font-size: 0.78rem;
                color: #9aa0aa;
                border-top: 1px solid #2a2f38;
                padding-top: 12px;
                margin-top: 2px;
                line-height: 1.4;
            }
            #sce-settings-footer {
                grid-column: 1 / -1;
                display: flex;
                justify-content: flex-end;
                gap: 10px;
                padding-top: 6px;
            }
            #sce-settings-save,
            #sce-settings-cancel {
                border: none;
                border-radius: 3px;
                padding: 7px 18px;
                font-size: 0.85rem;
                cursor: pointer;
                font-weight: 600;
            }
            #sce-settings-save { background: #3ba55c; color: #ffffff; }
            #sce-settings-save:hover { background: #349452; }
            #sce-settings-cancel { background: #3a3f47; color: #d8dbe0; }
            #sce-settings-cancel:hover { background: #454a53; }
        `;
        document.head.appendChild(style);
    }

    // =========================================================================
    // TOOLBAR BUTTONS
    // =========================================================================

    function addToolbarButtons() {
        const heading = $('span[class="tracking-wider font-league-gothic"]').eq(0);

        // Version button – inserted first so it ends up rightmost in the toolbar.
        heading.after(
            '&nbsp;<a class="btn-primary lg:w-min" id="sce-version"' +
            ' title="Click to open SCE Tools settings."' +
            ' href="#" onclick="event.preventDefault()">SCE Tools (v' + SCRIPT_VERSION + ')</a>'
        );
        $('#sce-version').on('click', openSettingsModal);

        heading.after(
            '&nbsp;<a class="btn-primary lg:w-min" id="sce-hide-toggles"' +
            ' title="Hide or show the original SCE filter toggle panel above the table. Note that using these toggles will break functionality of this tool">' +
            'Hide Toggles</a>'
        );
        $('#sce-hide-toggles').data('state', 'visible');
        $('#sce-hide-toggles').on('click', onHideTogglesClick);

        // Hide the page's filter toggle section immediately — before the table
        // is manipulated — so the user cannot accidentally click a toggle
        // during setup and break the column detection.
        onHideTogglesClick();

        heading.after(
            '&nbsp;<a class="btn-primary lg:w-min" id="sce-filter"' +
            ' title="Show only games at normal SCE price (rows with a green square at the front). Click again to show all.">' +
            'Show Green</a>'
        );
        $('#sce-filter').data('mode', 'green');
        $('#sce-filter').on('click', () => onFilterClick(TABLE_ID));

        if (IS_WATCHLIST) {
            heading.after(
                '&nbsp;<a class="btn-primary lg:w-min" id="sce-synch"' +
                ' title="Load your Steam card inventory and sync it with this Watchlist.' +
                ' You must be logged into the Steam Community (visit your Inventory page) in this browser.">SYNC</a>'
            );
            $('#sce-synch').on('click', onSynchClick);
        }

        if (!IS_WATCHLIST) {
            heading.after(
                '&nbsp;<a class="btn-primary lg:w-min" id="sce-booster"' +
                ' title="Calculate Booster Pack gem values for games you own.' +
                ' Requires being logged into the Steam Store in this browser.">' +
                'Booster Values</a>'
            );
            $('#sce-booster').one('click', onBoosterClick);
        }

        // Start the version button red immediately — the table isn't ready yet
        // and the user should not interact until S W columns are built.
        setVersionBtnState('updating');
    }

    // Updates the version button's text and colour to signal table state.
    // 'updating' → red, warns user not to interact.
    // 'ready'    → default blue (btn-primary), confirms the page is usable.
    //
    // Uses element.style.setProperty('prop', 'value', 'important') instead of
    // a CSS class because btn-primary's stylesheet rules (likely Tailwind with
    // !important) beat any class selector we add.  An inline !important set via
    // setProperty sits above every external stylesheet declaration.
    function setVersionBtnState(state) {
        const btn = document.getElementById('sce-version');
        if (!btn) return;
        const base = 'SCE Tools (v' + SCRIPT_VERSION + ')';
        if (state === 'updating') {
            btn.style.setProperty('background',       '#b52424', 'important');
            btn.style.setProperty('background-image', 'none',    'important');
            btn.style.setProperty('border-color',     '#8b1a1a', 'important');
            btn.style.setProperty('color',            '#ffffff',  'important');
            btn.textContent = base + ' \u2013 Updating table columns, do not interact with the page! Takes many seconds on Inventory page!';
        } else {
            btn.style.removeProperty('background');
            btn.style.removeProperty('background-image');
            btn.style.removeProperty('border-color');
            btn.style.removeProperty('color');
            btn.textContent = base + ' \u2013 Settings';
        }
    }

    // =========================================================================
    // WAIT FOR TABLE STABILITY
    // =========================================================================

    function waitForTable(tableId, callback) {
        const POLL_MS = 250;
        const STABLE_MS = 1000;
        const MAX_MS = 25000;
        // SCE's own paging shows 20 rows per page as the smallest chunk it ever
        // renders; a stable count below this almost always means the table is
        // still mid-render (e.g. one row painted, then a pause before the rest
        // arrive), not that the game/watch list genuinely has under 20 entries.
        const MIN_ROWS = 20;
        let fired = false;
        const start = Date.now();
        let lastCount = -1;
        let stableSince = Date.now();

        function proceed() {
            if (fired) return;
            fired = true;
            if ($.fn.DataTable.isDataTable('#' + tableId)) {
                const dt = $('#' + tableId).DataTable();
                if (dt.page.len() !== -1) {
                    $('#' + tableId).one('draw.dt', callback);
                    dt.page.len(-1).draw();
                    return;
                }
            }
            callback();
        }

        function poll() {
            const count = document.querySelectorAll('#' + tableId + ' tbody tr').length;
            const now = Date.now();
            if (count !== lastCount) { lastCount = count; stableSince = now; }
            const elapsed = now - start;
            // Below MIN_ROWS, keep polling regardless of stability UNLESS we've
            // hit MAX_MS — a table with genuinely fewer than 20 rows (e.g. a very
            // short watchlist) must still be allowed to proceed eventually.
            const stableLongEnough = (now - stableSince) >= STABLE_MS;
            if (count >= MIN_ROWS && stableLongEnough) {
                console.log('SCE Tools: table stable with ' + count + ' rows after ' + elapsed + ' ms.');
                proceed();
                return;
            }
            if (elapsed >= MAX_MS) {
                if (count > 0 && stableLongEnough) {
                    console.warn('SCE Tools: gave up waiting for ' + MIN_ROWS + '+ rows after ' + MAX_MS
                        + ' ms, proceeding with ' + count + ' row(s) \u2014 table may genuinely be this small.');
                } else {
                    console.warn('SCE Tools: gave up waiting after ' + MAX_MS + ' ms, proceeding with ' + count + ' row(s).');
                }
                proceed();
                return;
            }
            setTimeout(poll, POLL_MS);
        }

        setTimeout(poll, POLL_MS);
    }

    // =========================================================================
    // ON TABLE READY – ADD S W COLUMN AND SEPARATE BUTTON COLUMN
    // =========================================================================

    async function onTableReady() {
        setVersionBtnState('updating');
        // Yield one animation frame so the browser repaints the button red
        // before the synchronous DOM work blocks further painting.
        // sleep(50) yields to a separate setTimeout task so the browser has
        // time to actually paint the red button before synchronous DOM work
        // blocks rendering.  requestAnimationFrame fires BEFORE the paint and
        // therefore doesn't give the browser a chance to render the new state.
        await sleep(50);
        console.log('SCE Tools: table ready, adding S W column.');

        // Destroy DataTable before any structural DOM changes.
        dtDestroy(TABLE_ID);

        // Adjust column header widths.
        // Worth: w-14 (narrower, values are small numbers).
        // Cards in Set: w-24 (medium).
        // S W: w-24 (same as Cards in Set).
        $('#' + TABLE_ID + ' thead tr th').each(function (index) {
            if (index === COL_WORTH) {
                $(this).removeClass('w-32 w-24 w-20 w-16').addClass('w-14');
            } else if (index === COL_SETSIZE) {
                $(this).removeClass('w-32 w-20 w-16 w-14').addClass('w-24');
            } else if (index === COL_SW) {
                $(this).removeClass('w-32 w-20 w-16 w-14').addClass('w-24');
            }
        });

        // The Inventory page's own header text is "Worth (You Get)", which
        // doesn't fit the narrowed w-14 column. Shorten it to "Worth" (same
        // text the Watchlist page already uses for this column).
        $('#' + TABLE_ID + ' thead tr th').eq(COL_WORTH).contents().filter(function () {
            return this.nodeType === Node.TEXT_NODE;
        }).first().replaceWith('Worth');

        // Populate S W values and append an empty button cell to every row.
        $('#' + TABLE_ID + ' tbody tr').each(function () {
            const worth = parseInt($(this).find('td').eq(COL_WORTH).text(), 10) || 0;
            const setSize = parseInt($(this).find('td').eq(COL_SETSIZE).text(), 10) || 0;
            $(this).find('td').eq(COL_SW).text(Math.round(worth * setSize));
            $(this).append('<td></td>');
        });

        // Update headers.
        $('#' + TABLE_ID + ' thead tr th').eq(COL_SW)
            .text('S W')
            .attr('title', 'Set Worth: card price multiplied by the number of cards in the set.');
        $('#' + TABLE_ID + ' thead tr').append(
            '<th class="w-32" title="Trade Buttons\n\nS (Sell)\nSells your cards to the SCE bot. Looks at the SCE inventory and your current credits to make sure it only offers what SCE can actually accept. Favours cards SCE already has most of (furthest from its cap).\n\nB (Buy) and L (Limited Buy)\nBoth get cards from the bot. L limits the amount to exactly what you still need to finish your next badge; B always gets up to six. Both will never take more than six cards (the SCE trade limit) and will never get cards that would push you over the max badge level of 5. Cards you don\'t own yet are fetched first, then the most balanced spread possible.">T B</th>'
        );

        reinitDataTable(TABLE_ID, COL_SW, IS_WATCHLIST ? CFG.watchlistSort : CFG.inventorySort);
        addTradingButtons();
        setFilterState((IS_WATCHLIST ? CFG.watchlistFilter : CFG.inventoryFilter) === 'green');
        setVersionBtnState('ready');
        console.log('SCE Tools: S W column done.');
    }

    // =========================================================================
    // REINITIALISE DATATABLE
    // =========================================================================

    function dtDestroy(tableId) {
        if ($.fn.DataTable.isDataTable('#' + tableId)) {
            const dt = $('#' + tableId).DataTable();
            dt.state.clear();
            dt.destroy();
        }
    }

    function reinitDataTable(tableId, primaryCol, primaryDir, extraSortCols, extraColumnDefs) {
        extraSortCols = extraSortCols || [];
        extraColumnDefs = extraColumnDefs || [];
        const order = [[primaryCol, primaryDir]].concat(extraSortCols).concat([[0, 'asc']]);

        $('#' + tableId).dataTable({
            dom: 'rt<"dataTables_footer"ip>',
            searching: false,
            pageLength: -1,
            autoWidth: false,
            stateSave: false,
            columnDefs: [
                { type: 'num', targets: COL_SW },
                { orderable: false, targets: COL_BTN }
            ].concat(extraColumnDefs),
            order: order
        });

        $('#' + tableId).DataTable().order(order).draw(false);
    }

    // =========================================================================
    // FILTER: SHOW GREEN / SHOW ALL
    // =========================================================================

    function onFilterClick(tableId) {
        const showingAll = ($('#sce-filter').data('mode') === 'all');
        $('#' + tableId + ' tbody tr').each(function () {
            const isGreen = $(this).find('a div').hasClass('bg-key-green');
            const isUserRed = $(this).find('a').css('color') === 'rgb(255, 0, 0)';
            if (showingAll) {
                $(this).css('display', 'table-row');
            } else {
                $(this).css('display', (!isGreen || isUserRed) ? 'none' : 'table-row');
            }
        });
        const nextMode = showingAll ? 'green' : 'all';
        $('#sce-filter').data('mode', nextMode).text(showingAll ? 'Show Green' : 'Show All');
    }

    // =========================================================================
    // HIDE / SHOW TOGGLE PANEL
    // =========================================================================

    function onHideTogglesClick() {
        const isVisible = ($('#sce-hide-toggles').data('state') === 'visible');
        $('div[class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-0.5 my-0.5 items-start"]').toggle();
        const nextState = isVisible ? 'hidden' : 'visible';
        $('#sce-hide-toggles').data('state', nextState).text(isVisible ? 'Show Toggles' : 'Hide Toggles');
    }


    // =========================================================================
    // =========================================================================
    // BOOSTER VALUE CALCULATOR  (Inventory page only)
    // =========================================================================
    // =========================================================================

    let appsOwned = {};

    async function onBoosterClick() {
        const boosterBtn = document.getElementById('sce-booster');
        boosterBtn.style.setProperty('background',       '#b52424', 'important');
        boosterBtn.style.setProperty('background-image', 'none',    'important');
        boosterBtn.style.setProperty('border-color',     '#8b1a1a', 'important');
        boosterBtn.textContent = 'Loading\u2026 Do not interact with the page!';

        function restoreBooster(label) {
            boosterBtn.style.removeProperty('background');
            boosterBtn.style.removeProperty('background-image');
            boosterBtn.style.removeProperty('border-color');
            boosterBtn.textContent = label;
        }

        try {
            const data = await gmFetch('https://store.steampowered.com/dynamicstore/userdata/');
            if (!data.rgOwnedApps || data.rgOwnedApps.length === 0) {
                alert('You need to be logged into the Steam Store in this browser for this to work. You will likely also have to restart your browser.');
                restoreBooster('Booster Values');
                return;
            }
            data.rgOwnedApps.forEach(id => { appsOwned[id] = 1; });
            addBoosterColumn();
            restoreBooster('Done!');

            // Add link to Booster Creator if not already present.
            if (!document.getElementById('sce-booster-link')) {
                const link = document.createElement('a');
                link.id = 'sce-booster-link';
                link.className = 'btn-primary lg:w-min';
                link.href = 'https://steamcommunity.com/tradingcards/boostercreator/';
                link.target = '_blank';
                link.title = 'Opens the Steam Booster Creator in a new tab.';
                link.textContent = 'Open Booster Creator';
                // Insert a non-breaking space then the link after the Done! button.
                document.getElementById('sce-booster').after('\u00A0', link);
            }
        } catch (err) {
            alert('Failed to load Steam Store data: ' + err.message);
            restoreBooster('Booster Values');
            console.error('SCE Tools [Booster]:', err);
        }
    }

    function addBoosterColumn() {
        dtDestroy(TABLE_ID);

        $('#' + TABLE_ID + ' tbody tr').each(function () {
            const worth = parseInt($(this).find('td').eq(COL_WORTH).text(), 10) || 0;
            const setSize = parseInt($(this).find('td').eq(COL_SETSIZE).text(), 10) || 0;
            const href = $(this).find('a').attr('href') || '';
            const appId = href.substring(href.lastIndexOf('-') + 1);

            let bv = 0;
            if (appsOwned[appId] !== undefined && setSize > 0) {
                bv = Math.round((worth * 3) / Math.round(6000 / setSize) * 10000);
                $(this).css('display', 'table-row');
            } else {
                $(this).css('display', 'none');
            }
            $(this).append('<td>' + bv + '</td>');
        });

        $('#' + TABLE_ID + ' thead tr').append(
            '<th class="w-14" title="Booster Value: how many credits you can get at SCE for these cards compared to gem value cost, higher is better.">B V</th>'
        );

        reinitDataTable(TABLE_ID, COL_SYNCH_START, 'desc', [], [
            { type: 'num', targets: COL_SYNCH_START }
        ]);
    }


    // =========================================================================
    // =========================================================================
    // TRADING BUTTONS
    //
    // G – Get All      Fetch up to 6 cards the bot has (stock >= 2), balanced
    //                  spread, capped by the 5-badge limit.
    // M – Get Missing  Fetch only card types you are still missing, then fill
    //                  remaining slots with extras; capped by the 5-badge limit.
    // V – Give         Offer your cards to the bot for credits. Targets cards
    //                  where bot stock < 8, prioritising highest stock first
    //                  (most plentiful; furthest from acceptance being cut off).
    //
    // Buttons are blue by default, yellow when no qualifying cards exist.
    // Buttons go into COL_BTN (col 5), the separate non-sortable column.
    // =========================================================================
    // =========================================================================

    function addTradingButtons() {
        const rows = Array.from(document.querySelectorAll('#' + TABLE_ID + ' tbody tr'));
        if (rows.length === 0) return;

        const rowData = rows.map(function (row) {
            const tds = row.querySelectorAll('td');
            const setWorth = parseInt((tds[COL_SW] && tds[COL_SW].textContent) ? tds[COL_SW].textContent.trim() : '0', 10) || 0;
            const cardWorth = parseInt((tds[COL_WORTH] && tds[COL_WORTH].textContent) ? tds[COL_WORTH].textContent.trim() : '0', 10) || 0;
            const colorDiv = row.querySelector('a div');
            const isGreen = colorDiv ? colorDiv.classList.contains('bg-key-green') : false;
            const isGrey = colorDiv ? colorDiv.classList.contains('bg-key-gray-dark') : false;
            const isPurple = colorDiv ? colorDiv.classList.contains('bg-gray-bright') : false;
            // Detect user-stylesheet overrides that colour a game's name red
            // (used e.g. to mark games where 5 badges are already crafted).
            // getComputedStyle picks up applied userstyles, same as the filter does.
            const anchorEl = row.querySelector('a');
            const isUserRed = anchorEl
                ? window.getComputedStyle(anchorEl).color === 'rgb(255, 0, 0)'
                : false;
            // Non-Marketable cards can't be traded, so V buttons must never appear
            // on those rows. The game name always ends with " (Non-Marketable)".
            const gameName = anchorEl ? anchorEl.textContent : '';
            const isNonMarketable = /\(non-marketable\)/i.test(gameName);
            const href = (anchorEl && anchorEl.getAttribute('href')) || '';
            const appId = href.substring(href.lastIndexOf('-') + 1);
            const setSize = parseInt((tds[COL_SETSIZE] && tds[COL_SETSIZE].textContent) ? tds[COL_SETSIZE].textContent.trim() : '0', 10) || 0;
            return { row, setWorth, cardWorth, isGreen, isGrey, isPurple, isUserRed, isNonMarketable, appId, setSize };
        });

        // Wrap the "Cards in Set" cell in each row with a gamecards page link.
        // Done here, before DataTables init, so the link survives sorting.
        // The <a> is display:block so the entire cell width is clickable.
        // jQuery's .text() / .textContent on the td still returns the plain
        // number, so setSize reads elsewhere are unaffected.
        (function () {
            const headers = document.querySelectorAll('#' + TABLE_ID + ' thead tr th');
            if (headers[COL_SETSIZE]) {
                headers[COL_SETSIZE].title =
                    'Clicking in the column below opens the Badge page for the game in a new tab.';
            }
        }());
        rowData.forEach(function (r) {
            if (!r.appId) return;
            const cell = r.row.querySelectorAll('td')[COL_SETSIZE];
            if (!cell || cell.querySelector('.sce-gamecards-link')) return;
            const num = cell.textContent.trim();
            const a = document.createElement('a');
            a.href = 'https://steamcommunity.com/my/gamecards/' + r.appId;
            a.target = '_blank';
            a.rel = 'noopener';
            a.className = 'sce-gamecards-link';
            a.style.cssText = 'display:block;width:100%;color:inherit;text-decoration:none;';
            a.textContent = num;
            cell.textContent = '';
            cell.appendChild(a);
        });

        // B + L: green rows within Set Worth range of the minimum green value.
        // Exclude user-red rows AND blacklisted games from both the minimum
        // calculation and button placement — a blacklisted game shouldn't set
        // the baseline (e.g. cheapest green at S W 40 is blacklisted, next
        // cheapest is 45 → 45 becomes the baseline) and shouldn't receive
        // B/L buttons itself either, same as it already never gets an S button.
        const greenWorths = rowData
            .filter(function (r) {
                return r.isGreen && !r.isUserRed && r.setWorth > 0
                    && CFG.sBlacklist.indexOf(r.appId) === -1;
            })
            .map(function (r) { return r.setWorth; });
        if (greenWorths.length > 0) {
            const minWorth = Math.min.apply(null, greenWorths);
            const maxWorth = minWorth + CFG.blRange;
            const getButtonGames = [];
            rowData
                .filter(function (r) {
                    return r.isGreen && !r.isUserRed && r.setWorth <= maxWorth
                        && CFG.sBlacklist.indexOf(r.appId) === -1;
                })
                .forEach(function (r) {
                    const btns = addGetButtons(r.row, r.appId, r.setSize, r.cardWorth);
                    if (btns) getButtonGames.push({ appId: r.appId, setSize: r.setSize, cardWorth: r.cardWorth, btnG: btns.btnG, btnM: btns.btnM });
                });
            // Kick off sequential background pre-computation of counts and trade data.
            // Buttons update from "G"/"M" to "G: 5"/"M: 2" as results come in.
            precomputeGetButtons(getButtonGames);
        }

        // S: highest Set Worth non-grey, non-purple, non-Non-Marketable rows,
        // excluding blacklisted app IDs. The base count is CFG.sCount, but
        // if multiple games share the same Set Worth as the Nth entry, all of them
        // get a button so that no game is arbitrarily excluded from a tie group.
        // Added before the green filter so S buttons exist on red/blue rows too.
        if (IS_WATCHLIST) {
            var vCandidates = rowData
                .filter(function (r) {
                    return !r.isGrey && !r.isPurple && !r.isNonMarketable
                        && CFG.sBlacklist.indexOf(r.appId) === -1
                        && r.setWorth > 0;
                })
                .sort(function (a, b) { return b.setWorth - a.setWorth; });

            if (CFG.sCount > 0) {
                // Set Worth of the last "naturally included" entry (#N, 0-indexed).
                // Any candidate with the same value also gets a button.
                var cutoffWorth = vCandidates.length >= CFG.sCount
                    ? vCandidates[CFG.sCount - 1].setWorth : 0;
                var giveButtonGames = [];
                vCandidates
                    .filter(function (r, idx) { return idx < CFG.sCount || r.setWorth === cutoffWorth; })
                    .forEach(function (r) {
                        var btnV = addGiveButton(r.row, r.appId);
                        if (btnV) giveButtonGames.push({ appId: r.appId, cardWorth: btnV.cardWorth, btn: btnV.btn });
                    });
                // Same sequential, one-per-second pacing as the B/L precompute
                // queue — S buttons now also do live SCE + gamecards fetches
                // (see precomputeGiveTrade), so firing them all in parallel
                // would hit both sites simultaneously for every S button on
                // the page.
                precomputeGiveButtons(giveButtonGames);
            }
        }

        // Blacklisted games never get B, L, or S buttons (see the filters
        // above and precomputeGiveTrade's own exclusion) — this leaves their
        // T B cell empty with no explanation. Add a small dark "BL" indicator
        // so the reason is discoverable at a glance instead of looking like a
        // bug. Applies on both Watchlist and Inventory since the blacklist
        // now affects B/L on both pages, not just S on the Watchlist.
        if (CFG.sBlacklist.length > 0) {
            rowData.forEach(function (r) {
                if (CFG.sBlacklist.indexOf(r.appId) === -1) return;
                const cell = r.row.querySelectorAll('td')[COL_BTN];
                if (!cell) return;
                const span = document.createElement('span');
                span.className = 'sce-bl-indicator';
                span.textContent = 'BL';
                span.title = 'This game (AppID ' + r.appId + ') is on the Trade Button '
                    + 'Blacklist, so it never gets B, L, or S buttons.\n\n'
                    + 'To restore its buttons, open Settings (click the SCE Tools button) '
                    + 'and remove ' + r.appId + ' from the Trade Button Blacklist.';
                cell.appendChild(document.createTextNode('\u00A0'));
                cell.appendChild(span);
            });
        }
    }

    function addGetButtons(row, appId, setSize, cardWorth) {
        const cell = row.querySelectorAll('td')[COL_BTN];
        if (!cell) return null;

        // Extract the game name; collapse whitespace from any inline child elements.
        const nameAnchor = row.querySelector('td a');
        const gameName = nameAnchor
            ? nameAnchor.textContent.replace(/\s+/g, ' ').trim()
            : '';

        const btnG = makeTradingButton('B',
            'Buy: buy up to 6 different cards the bot has at normal price (stock \u2265 2), balanced across cards available, within 5-Steam badge cap');
        btnG.dataset.gameName = gameName;
        attachButtonHandlers(btnG, function () { onGetAllClick(appId, setSize, btnG); });

        const btnM = makeTradingButton('L',
            'Limited Buy: buy exactly the cards needed to finish your next badge (up to 6, balanced across cards available, within 5-Steam badge cap). When you own duplicate copies of other cards in the set and SCE still has room for them, L will also sell those spare copies in the same trade.');
        btnM.dataset.gameName = gameName;
        attachButtonHandlers(btnM, function () { onGetMissingClick(appId, setSize, btnM, cardWorth); });

        cell.appendChild(document.createTextNode('\u00A0'));
        cell.appendChild(btnG);
        cell.appendChild(document.createTextNode('\u00A0'));
        cell.appendChild(btnM);

        return { btnG: btnG, btnM: btnM };
    }

    function addGiveButton(row, appId) {
        const cell = row.querySelectorAll('td')[COL_BTN];
        if (!cell) return null;

        // Card worth is uniform across a set at normal price; read it from the
        // row so we can calculate the credit-cap limit at click time.
        const cardWorth = parseInt((row.querySelectorAll('td')[COL_WORTH] || {}).textContent || '0', 10) || 0;

        // Extract the game name; collapse whitespace from any inline child elements.
        const nameAnchor = row.querySelector('td a');
        const gameName = nameAnchor
            ? nameAnchor.textContent.replace(/\s+/g, ' ').trim()
            : '';

        const btnV = makeTradingButton('S',
            'Sell: sell your cards for this game to the SCE bot. Picks cards bot still' +
            ' accepts (stock < 8), highest stock first. 100c credit cap applies.');
        btnV.dataset.gameName = gameName;
        attachButtonHandlers(btnV, function () { onGiveClick(appId, btnV, cardWorth); });

        cell.appendChild(document.createTextNode('\u00A0'));
        cell.appendChild(btnV);

        // Precompute is queued and paced by precomputeGiveButtons (called from
        // addTradingButtons) rather than fired here, since it now does live
        // network fetches (see precomputeGiveTrade).
        return { btn: btnV, cardWorth: cardWorth };
    }

    function makeTradingButton(label, titleText) {
        const btn = document.createElement('a');
        btn.className = 'sce-trade-btn';
        btn.textContent = label;
        btn.title = titleText;
        btn.href = '#';
        btn.target = '_blank';
        btn.rel = 'noopener';
        return btn;
    }

    // Attaches mousedown + click + auxclick handlers that support both
    // normal left-click (foreground tab) and Ctrl/middle-click (background tab).
    //
    // btn._sce_pre is set after any successful computation. Two forms:
    //   { tradeData, botUrl }            – G/M buttons (items already chosen)
    //   { type:'give_deferred', sceCards, appId, cardWorth, botUrl }
    //                                    – V buttons (final selection done on the
    //                                      trade page using live inventory names)
    //
    // On each mousedown, if precomputed data exists, a FRESH trade ID is
    // generated synchronously so the href is ready before the browser acts on
    // the click — enabling real background tabs for middle and Ctrl+clicks.
    function attachButtonHandlers(btn, asyncAction) {
        btn.addEventListener('mousedown', function (e) {
            const pre = btn._sce_pre;
            if (!pre) {
                if (e.button === 1) e.preventDefault(); // stop blank middle-click tab
                return;
            }

            // Quick Trade: use GM_openInTab (userscript API) to open all URLs.
            // window.open is blocked by Chrome's popup gate even in mousedown;
            // GM_openInTab bypasses it entirely as a privileged userscript call.
            // All tabs open in the background so the user stays on SCE and can
            // review each trade in turn.
            if (pre.tradeData && pre.tradeData.type === 'get_quick') {
                var qtUrls = pre.tradeData.urls || [];
                console.log('SCE Tools [QT mousedown]: opening ' + qtUrls.length + ' tab(s) via GM_openInTab');
                qtUrls.forEach(function (url) {
                    GM_openInTab(url, { active: false, insert: true });
                });
                if (e.button === 1) e.preventDefault(); // stop blank middle-click tab
                return;
            }

            let tradeData;
            if (pre.type === 'give_deferred') {
                // Compute the credit-based card limit now, using the live balance.
                const currentCredits = getCurrentCredits();
                const maxCardsUnderCreditLimit = (currentCredits !== null && currentCredits > 0 && pre.cardWorth > 0)
                    ? Math.min(6, Math.floor(Math.max(0, 100 - currentCredits) / pre.cardWorth))
                    : 6;
                if (maxCardsUnderCreditLimit <= 0) {
                    btn.href = '#';
                    if (e.button === 1) e.preventDefault();
                    return;
                }
                // Pass sceCards + maxCardsUnderCreditLimit; the trade page resolves which items
                // to move using Steam's own live inventory item names.
                tradeData = { type: 'give', appId: pre.appId, sceCards: pre.sceCards, maxCardsUnderCreditLimit: maxCardsUnderCreditLimit, gameName: btn.dataset.gameName || '' };
            } else {
                tradeData = Object.assign({}, pre.tradeData, { gameName: btn.dataset.gameName || '' });
            }

            const tradeId = Date.now() + '_' + (Math.floor(Math.random() * 9000) + 1000);
            GM_setValue('sce_trade_' + tradeId, JSON.stringify(tradeData));
            const sep = pre.botUrl.includes('?') ? '&' : '?';
            const url = pre.botUrl + sep + 'sce_trade=' + tradeId;
            // Open in the foreground (tab or sized window per user setting).
            openTradeTarget(url);
            btn.dataset.sceOpened = '1';
            if (e.button === 1) e.preventDefault(); // stop blank middle-click tab
        });

        // Guards against a second click starting a concurrent trade
        // computation while one is already running on this button — without
        // this, rapidly double-clicking could race two onGetAllClick/
        // onGetMissingClick/onGiveClick calls against each other, each
        // overwriting the button's text/title/_sce_pre independently, and
        // potentially opening two trade tabs from one intended click.
        function runAsyncAction() {
            if (btn.dataset.sceBusy) return;
            btn.dataset.sceBusy = '1';
            Promise.resolve(asyncAction()).finally(function () {
                delete btn.dataset.sceBusy;
            });
        }

        // Left-click.
        btn.addEventListener('click', function (e) {
            const pre = btn._sce_pre;
            if (pre && pre.tradeData && pre.tradeData.type === 'get_quick') {
                // GM_openInTab in mousedown already opened all QT tabs.
                e.preventDefault();
                return;
            }
            // Injection trade: mousedown already called GM_openInTab (foreground) and
            // set sceOpened. Prevent the <a href="#"> from navigating a second time.
            if (btn.dataset.sceOpened) {
                delete btn.dataset.sceOpened;
                e.preventDefault();
                return;
            }
            e.preventDefault();
            runAsyncAction();
        });

        // Middle-click (auxclick fires after mousedown; click does not).
        btn.addEventListener('auxclick', function (e) {
            if (e.button !== 1) return;
            const pre = btn._sce_pre;
            if (pre && pre.tradeData && pre.tradeData.type === 'get_quick') {
                // GM_openInTab in mousedown already opened all QT tabs.
                e.preventDefault();
                return;
            }
            if (btn.dataset.sceOpened) {
                delete btn.dataset.sceOpened;
                e.preventDefault();
                return;
            }
            e.preventDefault();
            runAsyncAction();
        });
    }

    // Sets or clears the sce-l-N colour class on an L button to reflect how
    // many cards the trade will get.  1/2/3 use the Cards Needed colours;
    // any other count (or explicitly 0) clears all colour classes.
    function applyLButtonStyle(btn, count) {
        btn.classList.remove('sce-l-1', 'sce-l-2', 'sce-l-3');
        if (count >= 1 && count <= 3) btn.classList.add('sce-l-' + count);
    }

    // True if buying `selectedItems` would bring every card type in the set
    // to at least 1 copy — i.e. a badge becomes craftable immediately after
    // this trade, even if it wasn't craftable before.
    function wouldCompleteBadge(ownedCounts, selectedItems) {
        const afterCounts = Object.assign({}, ownedCounts);
        selectedItems.forEach(function (item) {
            const key = normalizeName(item.name);
            afterCounts[key] = (afterCounts[key] || 0) + 1;
        });
        const values = Object.values(afterCounts);
        return values.length > 0 && Math.min.apply(null, values) >= 1;
    }

    // Adds or removes the sce-completes-badge class (darker green highlight)
    // on a B/L button depending on whether the precomputed trade would
    // complete a badge.
    function applyCompletesBadgeStyle(btn, willComplete) {
        if (willComplete) btn.classList.add('sce-completes-badge');
        else btn.classList.remove('sce-completes-badge');
    }

    // True if buying `selectedItems` would leave the user holding more cards
    // than useful for the max badge level (5) — i.e. the resulting number of
    // craftable badges (min count across all card types, after the trade)
    // would exceed badgesLeft. Only used by the G/Buy button, which — unlike
    // L — intentionally keeps buying past what's needed for remaining
    // badges; this flags when that's happening so it's visible, not to stop it.
    function wouldExceedBadgeCap(ownedCounts, selectedItems, badgesLeft) {
        const afterCounts = Object.assign({}, ownedCounts);
        selectedItems.forEach(function (item) {
            const key = normalizeName(item.name);
            afterCounts[key] = (afterCounts[key] || 0) + 1;
        });
        const values = Object.values(afterCounts);
        if (values.length === 0) return false;
        const badgesCraftableAfter = Math.min.apply(null, values);
        return badgesCraftableAfter > badgesLeft;
    }

    // Adds or removes the sce-exceeds-badge-cap class (red highlight) on the
    // G/Buy button. Mutually exclusive with sce-completes-badge in practice —
    // callers should clear the other when setting this one.
    function applyExceedsBadgeCapStyle(btn, exceeds) {
        if (exceeds) btn.classList.add('sce-exceeds-badge-cap');
        else btn.classList.remove('sce-exceeds-badge-cap');
    }

    // Builds the tooltip text for a B/L button:
    //   Badge level: <current level>
    //   Cards Owned/Set Size: <total owned before this trade>/<set size>
    //   Getting card(s) (currently owned):
    //   <count getting> x <Card name> (<currently owned copies of this card>)   [one per line]
    function buildGetButtonTitle(badgeLevel, setSize, totalOwned, selectedItems, ownedCounts) {
        const order = [];
        const counts = {};
        const namesByKey = {};
        selectedItems.forEach(function (item) {
            const key = normalizeName(item.name);
            if (!(key in counts)) { counts[key] = 0; order.push(key); namesByKey[key] = item.name; }
            counts[key]++;
        });
        const cardLines = order.map(function (key) {
            return counts[key] + ' x ' + namesByKey[key] + ' (' + (ownedCounts[key] || 0) + ')';
        }).join('\n');
        return 'Badge level: ' + badgeLevel + '\n'
            + 'Cards Owned/Set Size: ' + totalOwned + '/' + setSize + '\n'
            + 'Getting card(s) (currently owned):\n'
            + cardLines;
    }

    function setButtonYellow(btn, reason) {
        btn.classList.add('yellow');
        btn.title = reason;
    }

    // Sets the L button's "a badge can already be crafted right now, with no
    // further trading" state — bright green, distinct from the darker green
    // used when a specific trade would newly enable crafting a badge.
    function setButtonCraftableNow(btn, badgesCraftableNow) {
        btn.classList.remove('yellow', 'sce-completes-badge');
        btn.classList.add('sce-craftable-now');
        btn.title = 'You can already craft ' + badgesCraftableNow
            + ' badge(s) with cards you own \u2014 craft ' + (badgesCraftableNow === 1 ? 'it' : 'one') + ' first!';
    }

    // Pre-computes the Give trade for an S button in the background.
    // Uses a LIVE gamecards-page scrape for per-card ownership counts (same
    // source and approach as the B/L buttons) instead of the old SYNC-cached
    // full-inventory blob — SYNC's own bulk fetch is still needed for the
    // CO/PB/CN/CR columns and watchlist add/remove, but S buttons are few
    // enough per page that a live per-game fetch is cheap and always current.
    // The actual card-name matching and selection still happen on the trade
    // page using Steam's own live inventory names, avoiding any cross-source
    // mismatch.
    async function precomputeGiveTrade(appId, btn, cardWorth, steamId) {
        try {
            const gcData = await fetchGamecards(steamId, appId);
            const ownedCounts = gcData.ownedCounts; // { normalizedName: count }
            const totalOwnedThisGame = Object.values(ownedCounts)
                .reduce(function (sum, n) { return sum + n; }, 0);
            if (totalOwnedThisGame === 0) return; // nothing owned — button falls back to click-time path

            const sceData = await fetchSceGamePage(appId);
            if (!sceData.botUrl || sceData.cards.length === 0) return;

            // Cross-reference: for each bot card type the bot can still accept
            // (stock < 8), check how many copies the user owns by normalized name.
            // This correctly turns the button yellow when the bot is at cap for
            // every card type the user specifically owns.
            let giveableCount = 0;
            sceData.cards.forEach(function (c) {
                if (c.stock < 8) {
                    const normName = normalizeName(c.name);
                    const userCopies = ownedCounts[normName] || 0;
                    giveableCount += Math.min(userCopies, 8 - c.stock);
                }
            });

            if (giveableCount === 0) {
                setButtonYellow(btn, 'No cards to give: bot is at stock cap (8) for all cards you own.');
                return;
            }

            const credits = getCurrentCredits();
            const maxByCredits = (credits !== null && credits > 0 && cardWorth > 0)
                ? Math.min(6, Math.floor(Math.max(0, 100 - credits) / cardWorth))
                : 6;
            const estimated = Math.min(giveableCount, maxByCredits, 6);

            if (estimated <= 0) {
                setButtonYellow(btn, 'Credit limit reached: cannot add any card without exceeding 100c.');
                return;
            }

            btn.textContent = 'S: ' + estimated + ' of ' + totalOwnedThisGame;
            btn.title = 'Total value: ' + (estimated * cardWorth) + 'c.';
            btn._sce_pre = {
                type: 'give_deferred',
                sceCards: sceData.cards,
                appId: appId,
                cardWorth: cardWorth,
                botUrl: sceData.botUrl
            };
        } catch (_) {
            // Silent failure – button still works via the click handler.
        }
    }

    // Processes games with G/M buttons sequentially, 1 second apart, so we
    // don't hammer SCE or Steam with simultaneous requests.  Each game's two
    // buttons update from "G"/"M" to "G: 5"/"M: 2" (or turn yellow) as soon
    // as that game's fetch pair completes.  If a game errors, it is skipped
    // silently and the buttons fall back to the click-time async path.
    // True if a trade tab has refreshed the loading heartbeat recently —
    // meaning it's actively waiting on Steam inventories right now.
    function isTradeTabLoadingInventories() {
        const ts = GM_getValue(TRADE_LOADING_HEARTBEAT_KEY, 0);
        return (Date.now() - ts) < TRADE_LOADING_HEARTBEAT_FRESH_MS;
    }

    // Pauses a precompute queue while a trade tab is actively loading
    // inventories, polling every 500ms until it's clear (either the trade
    // finished, failed, or the tab was closed and the heartbeat went stale).
    async function waitWhileTradeTabLoading() {
        while (isTradeTabLoadingInventories()) {
            await sleep(500);
        }
    }

    async function precomputeGetButtons(games) {
        if (games.length === 0) return;
        let steamId;
        try { steamId = await getSteamIdCached(); } catch (_) { return; }
        for (let i = 0; i < games.length; i++) {
            if (i > 0) await sleep(1000);
            await waitWhileTradeTabLoading();
            try { await precomputeOneGetGame(games[i], steamId); } catch (_) {}
        }
    }

    // Same pacing rationale as precomputeGetButtons: S buttons now fetch live
    // SCE + gamecards data (see precomputeGiveTrade), so they're processed
    // sequentially, one game per second, rather than all in parallel.
    async function precomputeGiveButtons(games) {
        if (games.length === 0) return;
        let steamId;
        try { steamId = await getSteamIdCached(); } catch (_) { return; }
        for (let i = 0; i < games.length; i++) {
            if (i > 0) await sleep(1000);
            await waitWhileTradeTabLoading();
            try { await precomputeGiveTrade(games[i].appId, games[i].btn, games[i].cardWorth, steamId); } catch (_) {}
        }
    }

    // Finds duplicate cards the user can sell to SCE in the SAME trade as an
    // L-button buy, so the buy is offset by selling cards that are surplus to
    // the badge currently being completed.
    //
    // A card type is "surplus" once you own more than the 1 copy needed for
    // the next badge (ownedCounts[type] - 1). It's only included if SCE still
    // has room for it (stock < 8); a full bot slot (stock === 8) is skipped
    // entirely, matching the S button's own acceptance rule.
    //
    // buyCount caps the total sold: never sell more than is being bought in
    // the same trade. Since buying and selling use the same per-card price
    // within a game, sell-count <= buy-count means credits can only stay flat
    // or go DOWN (buying costs more than an equal or smaller sell earns back)
    // — they can never increase, so there's no risk of hitting the 100c cap
    // and no need to check current credit balance at all.
    // Candidates are taken highest-bot-stock-first — cards SCE already has
    // the most of are favoured, same principle as the S button.
    function computeGiveAlongsideBuy(ownedCounts, sceCards, buyCount) {
        const capacityByName = {};
        sceCards.forEach(function (c) {
            if (c.stock < 8) {
                capacityByName[normalizeName(c.name)] = { capacity: 8 - c.stock, stock: c.stock, displayName: c.name };
            }
        });

        const candidates = Object.keys(ownedCounts)
            .map(function (name) {
                const surplus = ownedCounts[name] - 1;
                const cap = capacityByName[name];
                if (surplus <= 0 || !cap) return null;
                return { name: cap.displayName, giveCount: Math.min(surplus, cap.capacity), stock: cap.stock };
            })
            .filter(Boolean)
            .sort(function (a, b) { return b.stock - a.stock; });

        const cap = Math.min(6, buyCount);

        const giveItems = [];
        let total = 0;
        for (let i = 0; i < candidates.length && total < cap; i++) {
            const c = candidates[i];
            const take = Math.min(c.giveCount, cap - total);
            if (take > 0) {
                giveItems.push({ name: c.name, count: take });
                total += take;
            }
        }
        return { giveItems: giveItems, giveTotal: total };
    }

    async function precomputeOneGetGame(gameInfo, steamId) {
        const appId = gameInfo.appId;
        const setSize = gameInfo.setSize;
        const btnG = gameInfo.btnG;
        const btnM = gameInfo.btnM;

        const results = await Promise.all([
            fetchSceGamePage(appId),
            fetchGamecards(steamId, appId)
        ]);
        const sceData = results[0];
        const gcData = results[1];

        if (!sceData.botUrl) return;

        const badgesLeft = Math.max(0, 5 - gcData.badgeLevel);
        const ownedCounts = gcData.ownedCounts; // { normalizedName: count }, live from gamecards page, one entry per card type in the set
        const ownedValues = Object.values(ownedCounts);
        const totalOwned = ownedValues.reduce(function (a, b) { return a + b; }, 0);
        // Exact number of complete badges craftable RIGHT NOW from owned cards —
        // the minimum count across all card types (0 if any type is missing).
        // This replaces the old totalOwned/setSize approximation, which broke
        // whenever cards were unevenly distributed (e.g. owning 8 cards for an
        // 8-card set with duplicates of some types and zero of another still
        // triggered "start a fresh set", demanding a full extra set be bought).
        const badgesCraftableNow = ownedValues.length > 0 ? Math.min.apply(null, ownedValues) : 0;

        const available = sceData.cards.filter(function (c) { return c.stock >= 2; });

        // G button – balanced spread, always up to 6. Unlike L, G does NOT
        // stop at badge level 5 or once enough cards are held for all
        // remaining badges — some users want to keep buying past that point
        // (collecting, future badge levels if Steam ever raises the cap,
        // etc.). Instead, it's coloured red when THIS trade would leave the
        // user holding more cards than useful for the max badge level (5):
        // i.e. the trade would let them craft more badges than badgesLeft
        // allows for.
        if (available.length === 0) {
            setButtonYellow(btnG, 'No cards at normal price (stock \u2265 2) in the bot inventory.');
        } else {
            const selectedG = selectGetAllCards(available, 6, ownedCounts);
            if (selectedG.length === 0) {
                setButtonYellow(btnG, 'No cards qualify (all remaining copies are at last-card price).');
            } else {
                const qtG = CFG.useQt ? buildQuickTradeData(selectedG) : null;
                const uniqueG = new Set(selectedG.map(function(c){return normalizeName(c.name);})).size;
                btnG.textContent = 'B: ' + selectedG.length + ' (' + uniqueG + ')';
                btnG.title = buildGetButtonTitle(gcData.badgeLevel, setSize, totalOwned, selectedG, ownedCounts);
                if (wouldExceedBadgeCap(ownedCounts, selectedG, badgesLeft)) {
                    applyExceedsBadgeCapStyle(btnG, true);
                    applyCompletesBadgeStyle(btnG, false);
                } else {
                    applyExceedsBadgeCapStyle(btnG, false);
                    applyCompletesBadgeStyle(btnG, wouldCompleteBadge(ownedCounts, selectedG));
                }
                if (qtG) {
                    btnG.dataset.qt = '1';
                    btnG._sce_pre = { tradeData: qtG };
                } else {
                    delete btnG.dataset.qt;
                    btnG._sce_pre = { tradeData: { type: 'get', items: selectedG, appId: appId }, botUrl: sceData.botUrl };
                }
            }
        }

        // L button – exactly enough to complete the next INCOMPLETE badge.
        // Unlike G, L DOES stop once badge level 5 is reached or enough cards
        // are already held for all remaining badges — its whole purpose is
        // getting exactly what's needed, so there's nothing useful left to do.
        if (badgesLeft === 0 || badgesCraftableNow >= badgesLeft) {
            const msg = badgesLeft === 0
                ? 'Max badges (5) already reached for this game.'
                : 'Already own enough cards to craft all remaining badges';
            setButtonYellow(btnM, msg);
            return;
        }

        //
        // If badgesCraftableNow >= 1 the user can already craft a badge right
        // now with cards they own — the L button has nothing useful to buy,
        // so it goes yellow with a "craft it" message instead.
        //
        // Otherwise there are two distinct situations:
        //
        //   A) totalOwned < setSize — the user hasn't collected enough TOTAL
        //      cards for a full set yet. Buy up to (setSize - totalOwned),
        //      preferring 0-owned types (the balance algorithm already does
        //      this), but ALLOWING duplicates of already-owned types as a
        //      fallback when a still-missing type isn't purchasable. You can
        //      always trade a duplicate away later, but you can never
        //      complete a badge while short of the total cards needed.
        //
        //   B) totalOwned >= setSize (but badgesCraftableNow === 0, i.e. an

        //      uneven distribution — enough total cards, but at least one
        //      type still at 0). Here a duplicate really is wasted: the user
        //      already has "enough" raw cards, just not the right spread, so
        //      only the genuinely missing types are targeted; if none of
        //      those are purchasable, buy nothing rather than pad with dupes.
        if (badgesCraftableNow >= 1) {
            setButtonCraftableNow(btnM, badgesCraftableNow);
        } else if (available.length === 0) {
            setButtonYellow(btnM, 'No cards at normal price (stock \u2265 2) in the bot inventory.');
        } else {
            let cardsNeededForNextBadge, pool;
            const shortOfSetSize = totalOwned < setSize;

            if (shortOfSetSize) {
                // Situation A: still short of a full set's worth of total cards.
                cardsNeededForNextBadge = Math.min(6, setSize - totalOwned);
                pool = available; // duplicates of owned types are an acceptable fallback
            } else {
                // Situation B: enough total cards, but distribution is uneven.
                const availableNames = new Set(available.map(function (c) { return normalizeName(c.name); }));
                const missingNames = Object.keys(ownedCounts).filter(function (name) { return ownedCounts[name] === 0; });
                const purchasableMissing = missingNames.filter(function (name) { return availableNames.has(name); });

                if (purchasableMissing.length === 0) {
                    var missingDisplay = missingNames.map(function (n) {
                        var found = sceData.cards.find(function (c) { return normalizeName(c.name) === n; });
                        return found ? found.name : n;
                    });
                    setButtonYellow(btnM, 'Missing card(s) not available from the bot at normal price right now:\n'
                        + missingDisplay.join('\n'));
                    return;
                }

                cardsNeededForNextBadge = missingNames.length;
                pool = available.filter(function (c) { return ownedCounts[normalizeName(c.name)] === 0; });
            }

            const selectedM = selectGetAllCards(pool, cardsNeededForNextBadge, ownedCounts);
            if (selectedM.length === 0) {
                setButtonYellow(btnM, 'No cards qualify (all remaining copies are at last-card price).');
            } else {
                // Give-alongside-buy is only safe in Situation B. In Situation A
                // the user is still short of setSize total cards — giving away
                // ANY card right now would work directly against that, even if
                // it's technically a "surplus" duplicate, especially since the
                // bot's own stock may already be preventing the buy side from
                // reaching the full target (as happened here: bought fewer than
                // needed AND would have given one away, making the shortfall worse).
                const giveResult = shortOfSetSize
                    ? { giveItems: [], giveTotal: 0 }
                    : computeGiveAlongsideBuy(ownedCounts, sceData.cards, selectedM.length);
                // Quick Trade URLs are single-card, one-directional bot links —
                // they cannot carry a give-side item, so force injection whenever
                // this trade also sells surplus cards.
                const qtM = (CFG.useQt && giveResult.giveTotal === 0) ? buildQuickTradeData(selectedM) : null;
                const uniqueM = new Set(selectedM.map(function(c){return normalizeName(c.name);})).size;
                const sellSuffix = giveResult.giveTotal > 0 ? ' +S' + giveResult.giveTotal : '';
                btnM.textContent = 'L: ' + selectedM.length + ' (' + uniqueM + ')' + sellSuffix;
                btnM.title = buildGetButtonTitle(gcData.badgeLevel, setSize, totalOwned, selectedM, ownedCounts);
                applyCompletesBadgeStyle(btnM, wouldCompleteBadge(ownedCounts, selectedM));
                // Colour matches the CN column: based on cardsNeededForNextBadge
                // (how close the user is to completing the set), not how many
                // cards the bot happens to have available.
                btnM.dataset.lCn = cardsNeededForNextBadge;
                applyLButtonStyle(btnM, cardsNeededForNextBadge);
                if (qtM) {
                    btnM.dataset.qt = '1';
                    btnM._sce_pre = { tradeData: qtM };
                } else {
                    delete btnM.dataset.qt;
                    const tradeDataM = { type: 'get', items: selectedM, appId: appId };
                    if (giveResult.giveItems.length > 0) tradeDataM.giveItems = giveResult.giveItems;
                    btnM._sce_pre = { tradeData: tradeDataM, botUrl: sceData.botUrl };
                }
            }
        }
    }

    // Returns { type:'get_quick', urls:[...] } if every card in the selection:
    //   (a) has a Quick Trade URL scraped from the SCE page, AND
    //   (b) appears exactly once (no duplicate card types requested).
    // Quick Trade opens one pre-built Steam trade URL per card — no injection
    // needed, no inventory loading issues.  Returns null when not eligible
    // so the caller falls back to the standard injection system.
    function buildQuickTradeData(selected) {
        var names = selected.map(function (c) { return c.name; });
        var allUnique = new Set(names).size === names.length;
        var allHaveQt = selected.every(function (c) { return c.quickTradeUrl; });
        if (!allUnique || !allHaveQt) return null;
        return { type: 'get_quick', urls: selected.map(function (c) { return c.quickTradeUrl; }) };
    }

    // ── Click handlers ────────────────────────────────────────────────────────

    async function onGetAllClick(appId, setSize, btn) {
        btn.textContent = '\u2026';
        try {
            const steamId = await getSteamIdCached();
            const results = await Promise.all([
                fetchSceGamePage(appId),
                fetchGamecards(steamId, appId)
            ]);
            const sceData = results[0];
            const gcData = results[1];

            if (!sceData.botUrl) throw new Error('Could not find the trade URL on the SCE game page.');

            const badgesLeft = Math.max(0, 5 - gcData.badgeLevel);
            const ownedCounts = gcData.ownedCounts;
            const ownedValues = Object.values(ownedCounts);
            const totalOwned = ownedValues.reduce(function (a, b) { return a + b; }, 0);

            // No badge-level gate here — B intentionally keeps buying past
            // what's needed for remaining badges (some users want that for
            // collecting purposes); it's flagged red instead, see below.
            const available = sceData.cards.filter(function (c) { return c.stock >= 2; });
            if (available.length === 0) {
                setButtonYellow(btn, 'No cards at normal price (stock \u2265 2) in the bot inventory.');
                return;
            }
            const selected = selectGetAllCards(available, 6, ownedCounts);
            if (selected.length === 0) {
                setButtonYellow(btn, 'No cards qualify (all remaining copies are at last-card price).');
                return;
            }
            btn.title = buildGetButtonTitle(gcData.badgeLevel, setSize, totalOwned, selected, ownedCounts);
            if (wouldExceedBadgeCap(ownedCounts, selected, badgesLeft)) {
                applyExceedsBadgeCapStyle(btn, true);
                applyCompletesBadgeStyle(btn, false);
            } else {
                applyExceedsBadgeCapStyle(btn, false);
                applyCompletesBadgeStyle(btn, wouldCompleteBadge(ownedCounts, selected));
            }
            const qtData = CFG.useQt ? buildQuickTradeData(selected) : null;
            if (qtData) {
                btn.dataset.qt = '1';
                btn._sce_pre = { tradeData: qtData };
                qtData.urls.forEach(function (url) { window.open(url, '_blank'); });
                return;
            }
            const tradeData = { type: 'get', items: selected, gameName: btn.dataset.gameName || '', appId: appId };
            btn._sce_pre = { tradeData: tradeData, botUrl: sceData.botUrl };
            await openTrade(tradeData, sceData.botUrl);
        } catch (err) {
            setButtonYellow(btn, 'Error: ' + err.message);
            console.error('SCE Tools [B]:', err);
        } finally {
            if (btn.classList.contains('yellow')) {
                btn.textContent = 'B';
                delete btn.dataset.qt;
                applyCompletesBadgeStyle(btn, false);
                applyExceedsBadgeCapStyle(btn, false);
            } else {
                const pre = btn._sce_pre;
                if (pre && pre.tradeData) {
                    const td = pre.tradeData;
                    const count = td.type === 'get_quick' ? td.urls.length : (td.items ? td.items.length : 0);
                    const uniq = td.type === 'get_quick' ? td.urls.length
                        : (td.items ? new Set(td.items.map(function(i){return normalizeName(i.name);})).size : 0);
                    btn.textContent = 'B: ' + count + ' (' + uniq + ')';
                    if (td.type === 'get_quick') btn.dataset.qt = '1';
                    else delete btn.dataset.qt;
                } else {
                    btn.textContent = 'B';
                    delete btn.dataset.qt;
                }
            }
        }
    }

    // M button: get exactly the cards needed to complete the NEXT badge, up to
    // a maximum of 6.  Uses the same balanced round-robin spread as G but with
    // a lower cap derived from how many cards are still needed to finish the
    // current partial set.  Does NOT filter to only card types already missing
    // from the user's collection – it allows duplicates so the count fills the
    // gap as fully as the bot's available stock permits.
    async function onGetMissingClick(appId, setSize, btn, cardWorth) {
        btn.textContent = '\u2026';
        try {
            const steamId = await getSteamIdCached();
            const results = await Promise.all([
                fetchSceGamePage(appId),
                fetchGamecards(steamId, appId)
            ]);
            const sceData = results[0];
            const gcData = results[1];

            if (!sceData.botUrl) throw new Error('Could not find the trade URL on the SCE game page.');

            const badgesLeft = Math.max(0, 5 - gcData.badgeLevel);
            const ownedCounts = gcData.ownedCounts;
            const ownedValues = Object.values(ownedCounts);
            const totalOwned = ownedValues.reduce(function (a, b) { return a + b; }, 0);
            const badgesCraftableNow = ownedValues.length > 0 ? Math.min.apply(null, ownedValues) : 0;

            if (badgesLeft === 0 || badgesCraftableNow >= badgesLeft) {
                setButtonYellow(btn, badgesLeft === 0
                    ? 'Already at the maximum of 5 badges for this game.'
                    : 'Already own enough cards to craft all remaining badges');
                return;
            }
            const available = sceData.cards.filter(function (c) { return c.stock >= 2; });
            if (badgesCraftableNow >= 1) {
                setButtonCraftableNow(btn, badgesCraftableNow);
                return;
            }
            if (available.length === 0) {
                setButtonYellow(btn, 'No cards at normal price (stock \u2265 2) in the bot inventory.');
                return;
            }

            // See precomputeOneGetGame for the full rationale: situation A
            // (still short of setSize total cards) allows duplicate fallback;
            // situation B (enough total, uneven spread) targets missing types
            // only, going yellow if none of those are purchasable.
            let cardsNeededForNextBadge, pool;
            const shortOfSetSize = totalOwned < setSize;

            if (shortOfSetSize) {
                cardsNeededForNextBadge = Math.min(6, setSize - totalOwned);
                pool = available;
            } else {
                const availableNames = new Set(available.map(function (c) { return normalizeName(c.name); }));
                const missingNames = Object.keys(ownedCounts).filter(function (name) { return ownedCounts[name] === 0; });
                const purchasableMissing = missingNames.filter(function (name) { return availableNames.has(name); });

                if (purchasableMissing.length === 0) {
                    var missingDisplay = missingNames.map(function (n) {
                        var found = sceData.cards.find(function (c) { return normalizeName(c.name) === n; });
                        return found ? found.name : n;
                    });
                    setButtonYellow(btn, 'Missing card(s) not available from the bot at normal price right now:\n'
                        + missingDisplay.join('\n'));
                    return;
                }

                cardsNeededForNextBadge = missingNames.length;
                pool = available.filter(function (c) { return ownedCounts[normalizeName(c.name)] === 0; });
            }

            const selected = selectGetAllCards(pool, cardsNeededForNextBadge, ownedCounts);
            if (selected.length === 0) {
                setButtonYellow(btn, 'No cards qualify (all remaining copies are at last-card price).');
                return;
            }
            btn.dataset.lCn = cardsNeededForNextBadge; // persists for finally restore
            applyLButtonStyle(btn, cardsNeededForNextBadge);
            btn.title = buildGetButtonTitle(gcData.badgeLevel, setSize, totalOwned, selected, ownedCounts);
            applyCompletesBadgeStyle(btn, wouldCompleteBadge(ownedCounts, selected));

            // Give-alongside-buy is only safe in Situation B — see
            // precomputeOneGetGame for the full rationale. In Situation A the
            // user is still short of setSize total cards, so giving away a
            // card (even a "surplus" duplicate) works against closing that gap.
            const giveResult = shortOfSetSize
                ? { giveItems: [], giveTotal: 0 }
                : computeGiveAlongsideBuy(ownedCounts, sceData.cards, selected.length);
            // (giveTotal is recomputed from td.giveItems in the finally block
            // below, not read back from this button — no need to store it.)

            // Quick Trade cannot carry a give-side item; force injection when
            // this trade would also sell surplus cards.
            const qtData = (CFG.useQt && giveResult.giveTotal === 0) ? buildQuickTradeData(selected) : null;
            if (qtData) {
                btn.dataset.qt = '1';
                btn._sce_pre = { tradeData: qtData };
                qtData.urls.forEach(function (url) { window.open(url, '_blank'); });
                return;
            }
            const tradeData = { type: 'get', items: selected, gameName: btn.dataset.gameName || '', appId: appId };
            if (giveResult.giveItems.length > 0) tradeData.giveItems = giveResult.giveItems;
            btn._sce_pre = { tradeData: tradeData, botUrl: sceData.botUrl };
            await openTrade(tradeData, sceData.botUrl);
        } catch (err) {
            setButtonYellow(btn, 'Error: ' + err.message);
            console.error('SCE Tools [L]:', err);
        } finally {
            if (btn.classList.contains('sce-craftable-now')) {
                // Terminal "already craftable" state — setButtonCraftableNow
                // doesn't touch textContent, so reset it here (it's still the
                // spinner set at the top of this function otherwise).
                btn.textContent = 'L';
                delete btn.dataset.qt;
                applyLButtonStyle(btn, 0);
            } else if (btn.classList.contains('yellow')) {
                btn.textContent = 'L';
                delete btn.dataset.qt;
                applyLButtonStyle(btn, 0);
                applyCompletesBadgeStyle(btn, false);
            } else {
                const pre = btn._sce_pre;
                if (pre && pre.tradeData) {
                    const td = pre.tradeData;
                    const count = td.type === 'get_quick' ? td.urls.length : (td.items ? td.items.length : 0);
                    const uniq = td.type === 'get_quick' ? td.urls.length
                        : (td.items ? new Set(td.items.map(function(i){return normalizeName(i.name);})).size : 0);
                    const giveTotal = td.giveItems
                        ? td.giveItems.reduce(function (s, g) { return s + g.count; }, 0)
                        : 0;
                    const sellSuffix = giveTotal > 0 ? ' +S' + giveTotal : '';
                    btn.textContent = 'L: ' + count + ' (' + uniq + ')' + sellSuffix;
                    if (td.type === 'get_quick') btn.dataset.qt = '1';
                    else delete btn.dataset.qt;
                    applyLButtonStyle(btn, parseInt(btn.dataset.lCn || '0', 10));
                } else {
                    btn.textContent = 'L';
                    delete btn.dataset.qt;
                }
            }
        }
    }

    async function onGiveClick(appId, btn, cardWorth) {
        btn.textContent = '\u2026';
        try {
            const steamId = await getSteamIdCached();
            const gcData = await fetchGamecards(steamId, appId);
            const ownedCounts = gcData.ownedCounts;
            const totalOwnedThisGame = Object.values(ownedCounts)
                .reduce(function (sum, n) { return sum + n; }, 0);
            if (totalOwnedThisGame === 0) {
                throw new Error('You do not own any cards for this game.');
            }

            const currentCredits = getCurrentCredits();
            const sceData = await fetchSceGamePage(appId);
            if (!sceData.botUrl) throw new Error('Could not find the trade URL on the SCE game page.');

            if (!sceData.cards.some(function (c) { return c.stock < 8; })) {
                setButtonYellow(btn, 'No cards to give: bot is at stock cap (8) for all card types.');
                return;
            }

            const maxCardsUnderCreditLimit = (currentCredits !== null && currentCredits > 0 && cardWorth > 0)
                ? Math.min(6, Math.floor(Math.max(0, 100 - currentCredits) / cardWorth))
                : 6;
            if (maxCardsUnderCreditLimit <= 0) {
                const creditsNow = currentCredits !== null ? currentCredits + 'c' : 'unknown';
                setButtonYellow(btn, 'Credit limit reached: at ' + creditsNow + ', adding any card would exceed 100c.');
                return;
            }

            // Card-name matching happens on the trade page using Steam's live
            // inventory names, which avoids any cross-source name mismatch.
            btn.title = 'Total value: ' + (maxCardsUnderCreditLimit * cardWorth) + 'c.';
            btn.textContent = 'S: ' + maxCardsUnderCreditLimit + ' of ' + totalOwnedThisGame;
            btn._sce_pre = {
                type: 'give_deferred',
                sceCards: sceData.cards,
                appId: appId,
                cardWorth: cardWorth,
                botUrl: sceData.botUrl
            };
            await openTrade({ type: 'give', appId: appId, sceCards: sceData.cards, maxCardsUnderCreditLimit: maxCardsUnderCreditLimit, gameName: btn.dataset.gameName || '' }, sceData.botUrl);
        } catch (err) {
            setButtonYellow(btn, 'Error: ' + err.message);
            console.error('SCE Tools [S]:', err);
        } finally {
            // Only reset the spinner; keep yellow state or any precomputed count.
            if (btn.textContent === '\u2026') btn.textContent = 'S';
        }
    }

    // ── Selection algorithms ──────────────────────────────────────────────────

    // Returns up to maxCardsUnderCreditLimit items from available cards using a round-robin
    // spread: one copy of each card in descending stock order, repeated until
    // full. This maximises variety.
    //
    // The allocation cap per card is (stock - 1), not stock. Taking the last
    // card costs 1.5× the normal credit amount (SCE Last Card Fee), so we
    // always leave at least one copy in the bot's inventory.

    // Selects up to maxCards cards from the bot's available stock.
    //
    // When ownedCounts ({ normalizedName: count }, from the live gamecards scrape) is
    // supplied, uses a "balance after trade" greedy algorithm:
    //
    //   Each pick goes to the card type where (owned + already-selected) is
    //   lowest.  This means cards the user has 0 of are always taken first,
    //   then cards they have fewest of, producing the most even spread
    //   possible after the trade completes.  Ties are broken by highest bot
    //   stock (most plentiful card type first).
    //
    // Without ownedCounts (SYNC not run yet), falls back to a round-robin
    // across card types sorted by bot stock — same spread as before.
    //
    // Never requests the last copy of any card (stock - 1 cap) to avoid the
    // Last Card Fee.
    function selectGetAllCards(available, maxCards, ownedCounts) {
        if (ownedCounts) {
            // ── Balance-after-trade greedy pick ───────────────────────────
            var inSel = {};
            available.forEach(function (c) { inSel[c.name] = 0; });

            var result = [];
            for (var pick = 0; pick < maxCards; pick++) {
                var best = null, bestScore = Infinity, bestStock = -1;
                for (var i = 0; i < available.length; i++) {
                    var c = available[i];
                    var sel = inSel[c.name] || 0;
                    if (sel >= c.stock - 1) continue; // hit the last-card cap
                    var score = (ownedCounts[normalizeName(c.name)] || 0) + sel;
                    if (score < bestScore || (score === bestScore && c.stock > bestStock)) {
                        bestScore = score;
                        best = c;
                        bestStock = c.stock;
                    }
                }
                if (!best) break;
                inSel[best.name]++;
                result.push({ name: best.name, imageHash: best.imageHash,
                              quickTradeUrl: best.quickTradeUrl || null });
            }
            return result;
        }

        // ── Fallback: round-robin by bot stock (no SYNC data) ─────────────
        const sorted = available.slice().sort(function (a, b) { return b.stock - a.stock; });
        const allocation = {};
        sorted.forEach(function (c) { allocation[c.name] = 0; });
        let remaining = maxCards;
        while (remaining > 0) {
            let added = 0;
            for (let i = 0; i < sorted.length; i++) {
                if (remaining <= 0) break;
                const c = sorted[i];
                if (allocation[c.name] < c.stock - 1) {
                    allocation[c.name]++;
                    remaining--;
                    added++;
                }
            }
            if (added === 0) break;
        }
        const result2 = [];
        sorted.forEach(function (c) {
            for (let i = 0; i < (allocation[c.name] || 0); i++) {
                result2.push({ name: c.name, imageHash: c.imageHash,
                               quickTradeUrl: c.quickTradeUrl || null });
            }
        });
        return result2;
    }

    // ── SCE game page ─────────────────────────────────────────────────────────

    async function fetchSceGamePage(appId) {
        const url = 'https://www.steamcardexchange.net/index.php?inventorygame-appid-' + appId;
        const response = await fetch(url);
        if (!response.ok) throw new Error('SCE game page HTTP ' + response.status + ' for app ' + appId);
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        let botUrl = null;
        const makeOfferLink = doc.querySelector('a[href*="tradeoffer/new/?partner"]');
        if (makeOfferLink) {
            try {
                const href = makeOfferLink.getAttribute('href');
                const params = new URLSearchParams(href.split('?')[1] || '');
                const partner = params.get('partner');
                const token = params.get('token');
                if (partner && token) {
                    botUrl = 'https://steamcommunity.com/tradeoffer/new/?partner=' + partner + '&token=' + token;
                }
            } catch (_) { /* leave null */ }
        }

        const cards = [];
        doc.querySelectorAll('div.bg-gray-dark').forEach(function (div) {
            const nameEl = div.querySelector('.text-sm.break-words');
            if (!nameEl) return;
            const name = nameEl.textContent.trim();

            const imgSrc = (div.querySelector('img') && div.querySelector('img').getAttribute('src')) || '';
            const hashMatch = imgSrc.match(/\/economy\/image\/([A-Za-z0-9_-]+)\//);
            const imageHash = hashMatch ? hashMatch[1] : null;

            // text-key-green = stock 2-7 (normal price)
            // text-key-red   = stock 1  (last card, premium price)
            // text-key-yellow= stock 8  (overstocked, bot not accepting more)
            // absent         = stock 0  (not available)
            const stockEl = div.querySelector('[class*="text-key-"]');
            let stock = 0;
            if (stockEl) {
                const m = stockEl.textContent.match(/\d+/);
                stock = m ? parseInt(m[0], 10) : 0;
            }
            const qtLink = div.querySelector('a[href*="for_tradingcard"]');
            const quickTradeUrl = qtLink ? qtLink.getAttribute('href') : null;
            cards.push({ name: name, imageHash: imageHash, stock: stock, quickTradeUrl: quickTradeUrl });
        });

        return { botUrl: botUrl, cards: cards };
    }

    // ── Steam Badge/gamecards page ──────────────────────────────────────────────────
    //
    // The gamecards page (steamcommunity.com/profiles/{id}/gamecards/{appId}) shows,
    // for every card in the set, whether it's owned and — critically — exactly how
    // many copies: e.g. "GAPS 2/7 "DIVE ME" (1)" or "GAPS 3/7 "ART" (6)". Unowned
    // cards show no count at all. This gives us authoritative, always-current
    // per-card ownership without pulling the user's entire Steam inventory — one
    // page fetch per game precomputed, scoped exactly to that game.
    async function fetchGamecards(steamId, appId) {
        const url = 'https://steamcommunity.com/profiles/' + steamId + '/gamecards/' + appId;
        const html = await gmFetch(url, { raw: true });
        const doc = new DOMParser().parseFromString(html, 'text/html');

        let badgeLevel = 0;
        const lvlMatch = doc.body.textContent.match(/Level\s+(\d+),\s*\d+\s*XP/);
        if (lvlMatch) badgeLevel = parseInt(lvlMatch[1], 10);

        // { normalizedCardName: countOwned } — includes 0 entries for unowned cards
        // so callers can always tell "known card, 0 copies" from "unknown card".
        const ownedCounts = {};
        doc.querySelectorAll('.badge_card_set_card').forEach(function (div) {
            const isOwned = div.classList.contains('owned') || !!div.querySelector('.badge_card_set_card_owned');
            const textEl = div.querySelector('.badge_card_set_text');
            if (!textEl) return;

            // Card name: first text node in the text block (unchanged approach —
            // avoids picking up the "(N)" count or "Load card price" link text).
            let rawName = '';
            const nodes = textEl.childNodes;
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].nodeType === Node.TEXT_NODE) {
                    const t = nodes[i].textContent.trim();
                    if (t) { rawName = t; break; }
                }
            }
            if (!rawName && textEl.firstElementChild) {
                rawName = textEl.firstElementChild.textContent.trim();
            }
            if (!rawName) return;
            const normName = normalizeName(rawName);

            if (!isOwned) {
                ownedCounts[normName] = 0;
                return;
            }

            // The count appears as "(N)" right after the title, e.g.
            // GAPS 2/7 "DIVE ME" (1)
            // Using the FULL textContent and searching anywhere in it (not
            // anchored to end-of-line) because block-level child elements do
            // NOT insert literal "\n" characters into textContent — splitting
            // on '\n' returned the whole concatenated block, silently failing
            // the anchored match and defaulting every owned card to count 1.
            // Neither the card's title nor "Load card price" contain digits in
            // parentheses, so a first-match search is unambiguous.
            const fullText = textEl.textContent || '';
            const countMatch = fullText.match(/\((\d+)\)/);
            // Owned but no visible count is unexpected but treat as 1 (own at
            // least the one shown) rather than silently dropping the card.
            ownedCounts[normName] = countMatch ? parseInt(countMatch[1], 10) : 1;
        });

        return { badgeLevel: badgeLevel, ownedCounts: ownedCounts };
    }

    // ── Open trade ────────────────────────────────────────────────────────────

    // Opens a URL for an injection trade in either a foreground tab or a
    // sized popup window, depending on the user's preference.
    // Quick Trade URLs always use GM_openInTab regardless of this setting.
    function openTradeTarget(url) {
        if (CFG.tradeOpenMode === 'window') {
            // Sized popup window: each trade gets its own foreground window,
            // allowing multiple trades to be open and injecting simultaneously.
            // Dimensions close to STM's popup (1010 × 900) for a familiar layout.
            window.open(url, '_blank', 'width=890,height=880,scrollbars=yes');
        } else {
            GM_openInTab(url, { active: true, insert: true });
        }
    }

    async function openTrade(tradeData, botUrl) {
        const tradeId = Date.now() + '_' + (Math.floor(Math.random() * 9000) + 1000);
        GM_setValue('sce_trade_' + tradeId, JSON.stringify(tradeData));
        const sep = botUrl.includes('?') ? '&' : '?';
        const url = botUrl + sep + 'sce_trade=' + tradeId;
        // Open in the foreground so Steam's inventory API calls are not throttled.
        openTradeTarget(url);
    }


    // =========================================================================
    // =========================================================================
    // WATCHLIST SYNCHRONISER
    // =========================================================================
    // =========================================================================

    let $statusDiv = null;

    function statusMsg(html) {
        if ($statusDiv) $statusDiv.append('<p>' + html + '</p>');
    }

    async function onSynchClick() {
        setVersionBtnState('updating');
        // Replace the click handler immediately so a double-click can't restart
        // a sync while one is already running.  The button becomes a toggle for
        // the info div once the sync completes.
        $('#sce-synch').off('click').text('Syncing…').prop('disabled', true);
        $statusDiv = $('<div class="p-2 mx-auto mt-0.5 leading-none bg-black" style="line-height:1.8;" id="sce-synch-status"></div>');
        $('div[class="flex items-center p-2 mx-auto mt-0.5 leading-none bg-black"]').after($statusDiv);
        statusMsg('Starting Sync &ndash; you must be logged into the Steam Community (your Inventory page) *in this browser* for this to work.');

        try {
            $statusDiv.append('<p id="sce-s-steamid">Fetching your Steam ID&hellip;</p>');
            const steamId = await getSteamId();
            GM_setValue('sce_steamId', steamId);
            $('#sce-s-steamid').html('Steam ID resolved: <strong>' + steamId + '</strong>.');

            $statusDiv.append('<p>Loading Steam card inventory&hellip; <span id="sce-s-pages">Pages: </span></p>');
            const cardAmounts = await getAllCardCounts(steamId);
            statusMsg('Inventory loaded &ndash; found trading cards for <strong>' + Object.keys(cardAmounts).length + '</strong> game(s).');

            const removedIds = await syncWatchlist(cardAmounts);
            const rowsRemoved = removeStaleRows(removedIds);
            if (rowsRemoved > 0) {
                // Append onto "Finished removing all entries." — same line, no new <p>.
                $statusDiv.find('p').last().append(
                    ' Removed <strong>' + rowsRemoved + '</strong> game(s) with no cards from the table.'
                );
            }
            await addInventoryColumns(cardAmounts);
            setFilterState(true); // always show only green after SYNC
            statusMsg('<strong>Sync complete.</strong>');
        } catch (err) {
            statusMsg('<strong style="color:#d30000;">Error:</strong> ' + err.message);
            console.error('SCE Tools (SYNC):', err);
        } finally {
            // Guarantee the button returns to ready even if an error fires
            // before addInventoryColumns (which manages the state internally).
            setVersionBtnState('ready');
            // Turn the SYNC button into a toggle for the info div.
            $('#sce-synch')
                .prop('disabled', false)
                .text('Hide Sync Info')
                .off('click')
                .on('click', function () {
                    $statusDiv.toggle();
                    $(this).text($statusDiv.is(':visible') ? 'Hide Sync Info' : 'Show Sync Info');
                });
        }
    }

    // =========================================================================
    // GET STEAM ID
    // =========================================================================

    function getSteamId() {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://steamcommunity.com/my/',
                timeout: 10000,
                onload: function (response) {
                    const fromUrl = response.finalUrl.match(/\/profiles\/(\d{17})/);
                    if (fromUrl) { resolve(fromUrl[1]); return; }
                    const fromPage = response.responseText.match(/"steamid"\s*:\s*"(\d{17})"/);
                    if (fromPage) { resolve(fromPage[1]); return; }
                    reject(new Error('Could not determine your Steam ID. Make sure you are logged into the Steam Community (steamcommunity.com) in this browser.'));
                },
                onerror: function (r) {
                    reject(new Error('Could not reach steamcommunity.com: ' + (r.statusText || 'network error')));
                },
                ontimeout: function () {
                    reject(new Error('Request to steamcommunity.com timed out.'));
                }
            });
        });
    }

    // =========================================================================
    // LOAD ALL CARD COUNTS FROM STEAM INVENTORY
    // =========================================================================

    async function getAllCardCounts(steamId) {
        const cardAmounts = {};
        // descCache persists across all pages: classid → { cardName, appId }
        // Steam's inventory API does not always repeat descriptions for a card type
        // on subsequent pages even when more copies of that card appear there.
        // Without this cache, assets on pages 2+ whose descriptions only appeared
        // on page 1 are silently ignored, causing the SYNCH to miss asset IDs.
        const descCache = {};
        let startAssetId = null;
        let page = 0;
        const referer = 'https://steamcommunity.com/profiles/' + steamId + '/inventory/';

        while (true) {
            page++;
            $('#sce-s-pages').append((page > 1 ? ', ' : '') + page);
            let url = 'https://steamcommunity.com/inventory/' + steamId + '/753/6?l=english&count=2500';
            if (startAssetId) url += '&start_assetid=' + startAssetId;

            const data = await gmFetch(url, { headers: { Referer: referer } });
            if (!data || !data.success) {
                const detail = data ? JSON.stringify(data).substring(0, 200) : '(empty response)';
                throw new Error('Steam reported a failure for the inventory request. ' + detail);
            }

            parseInventoryPage(data, cardAmounts, descCache);

            if (data.more_items && data.last_assetid) {
                startAssetId = data.last_assetid;
                await sleep(1000);
            } else {
                $('#sce-s-pages').append('.');
                break;
            }
        }

        // cardAmounts ({ appId: totalCount }) lives only in memory for the
        // duration of this SYNC — it's passed directly into syncWatchlist and
        // addInventoryColumns and is not persisted. There is no longer a need
        // to store the full per-card inventory breakdown: the B/L/S buttons
        // all now read live per-game data from the SCE and gamecards pages
        // instead of a cached full-account snapshot.
        return cardAmounts;
    }

    // =========================================================================
    // PARSE ONE PAGE OF INVENTORY JSON
    // =========================================================================

    // descCache (classid → { cardName, appId }) is built up as
    // descriptions are encountered and then used to classify assets on ALL pages,
    // not just the page where a card type's description happened to appear.
    // Key design note: we key on classid ALONE, not classid+instanceid.
    // For the 753/6 (trading cards) context, each card type has a unique classid
    // regardless of how it was obtained. Cards received via trades are assigned
    // a non-zero instanceid on the asset entry, but their description in the API
    // response always carries instanceid 0. Keying on classid+instanceid causes
    // traded cards to silently fail the description lookup — exactly the bug that
    // made only the drop-obtained Sleet show up while traded Bouncer and Sentry
    // were ignored.
    function parseInventoryPage(data, cardAmounts, descCache) {
        // Step 1: count assets on this page, keyed by classid only.
        const assetCounts = {};
        const assets = data.assets || [];
        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i];
            const key = asset.classid;
            assetCounts[key] = (assetCounts[key] || 0) + (parseInt(asset.amount, 10) || 1);
        }

        // Step 2: update the description cache from this page's descriptions.
        // Descriptions also keyed by classid only.
        const descs = data.descriptions || [];
        for (let i = 0; i < descs.length; i++) {
            const desc = descs[i];
            if (!desc.type || !desc.type.includes('Trading Card')) continue;
            if (desc.type.includes('Foil Trading Card')) continue;
            if (!desc.market_fee_app) continue;
            const key = desc.classid;
            if (!descCache[key]) {
                const cardName = normalizeName(desc.name || '');
                if (cardName) {
                    descCache[key] = { cardName: cardName, appId: String(desc.market_fee_app) };
                }
            }
        }

        // Step 3: classify every asset on this page using the full cache,
        // which now includes descriptions from all previously processed pages.
        const keys = Object.keys(assetCounts);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const info = descCache[key];
            if (!info) continue; // Not a known trading card
            const count = assetCounts[key];
            cardAmounts[info.appId] = (cardAmounts[info.appId] || 0) + count;
        }
    }

    // =========================================================================
    // SYNC WATCHLIST AGAINST INVENTORY
    // =========================================================================

    async function syncWatchlist(cardAmounts) {
        // Use a precise selector for game links only to avoid picking up
        // href="#" from trade buttons or any other non-game anchors.
        const watchlistIds = new Set(
            $('table.dataTable a[href*="inventorygame-appid-"]').map(function () {
                const href = $(this).attr('href') || '';
                const m = href.match(/inventorygame-appid-(\d+)/);
                return m ? m[1] : null;
            }).get().filter(Boolean)
        );

        statusMsg('Games in SCE Watchlist: <strong>' + watchlistIds.size + '</strong>');

        const inventoryIds = new Set(Object.keys(cardAmounts));
        const toAdd = Array.from(inventoryIds).filter(function (id) { return !watchlistIds.has(id); });
        const toRemove = Array.from(watchlistIds).filter(function (id) { return !inventoryIds.has(id); });

        statusMsg(
            'Games to <strong>add</strong>: <strong>' + toAdd.length + '</strong>' +
            '&emsp;|&emsp;Games to <strong>remove</strong>: <strong>' + toRemove.length + '</strong>'
        );

        if (toAdd.length === 0 && toRemove.length === 0) {
            statusMsg('Watchlist is already in sync &ndash; no changes needed.');
            return [];
        }

        if (toAdd.length > 0) {
            // Names aren't available for newly-added games — cardAmounts only
            // has {appId: count}, and fetching a name per new game would mean
            // an extra network call per game (potentially dozens on a first
            // SYNC), which runs against SYNC's own bulk-efficiency design.
            appendAppIdLinks(toAdd, 'add');
            await modifyWatchlist('add', toAdd);
        }
        if (toRemove.length > 0) {
            // Unlike toAdd, these games are still rows in the current
            // watchlist table — their names are free to read from the DOM
            // before this SYNC (or removeStaleRows afterward) removes them.
            const removeNames = {};
            toRemove.forEach(function (id) {
                const a = document.querySelector(
                    'table.dataTable a[href*="inventorygame-appid-' + id + '"]'
                );
                if (a) removeNames[id] = a.textContent.replace(/\s+/g, ' ').trim();
            });
            appendAppIdLinks(toRemove, 'remove', removeNames);
            await modifyWatchlist('remove', toRemove);
        }

        return toRemove; // caller uses this to remove stale rows from the table
    }

    // Removes table rows whose game is no longer in the user's card inventory.
    // Called after syncWatchlist so the removed AppIDs are already known.
    // DataTables is re-initialised by addInventoryColumns immediately after,
    // so it is safe to destroy it here and manipulate raw <tr> elements.
    function removeStaleRows(removedIds) {
        if (!removedIds || removedIds.length === 0) return 0;
        const idSet = new Set(removedIds);
        dtDestroy(TABLE_ID); // safe to call even if already destroyed
        let count = 0;
        $('#' + TABLE_ID + ' tbody tr').each(function () {
            const href = $(this).find('a[href*="inventorygame-appid-"]').attr('href') || '';
            const m = href.match(/inventorygame-appid-(\d+)/);
            if (m && idSet.has(m[1])) {
                $(this).remove();
                count++;
            }
        });
        return count;
    }

    function appendAppIdLinks(appIds, action, nameLookup) {
        const verb = action === 'add' ? 'Adding' : 'Removing';
        let html = '<p>' + verb + ':</p>';
        for (let i = 0; i < appIds.length; i++) {
            const id = appIds[i];
            const label = (nameLookup && nameLookup[id]) ? nameLookup[id] : id;
            html += '<a id="sce-app-' + id + '"' +
                ' href="https://www.steamcardexchange.net/index.php?inventorygame-appid-' + id + '"' +
                ' title="AppID: ' + id + '"' +
                ' style="display:inline-block;margin:4px 6px 4px 0;" target="_blank">' + label + '</a>';
        }
        statusMsg(html);
    }

    async function modifyWatchlist(action, appIds) {
        const successColour = action === 'add' ? '#1daf07' : '#b52426';
        for (let i = 0; i < appIds.length; i++) {
            const id = appIds[i];
            try {
                const response = await fetch(
                    'https://www.steamcardexchange.net/index.php?inventorygame-appid-' + id,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: encodeURIComponent(action) + '=true'
                    }
                );
                if (response.status === 503) {
                    statusMsg('<strong style="color:#d30000;">Rate limited by SCE.</strong> Some entries may not have been processed.');
                    return;
                }
                if (!response.ok) throw new Error('HTTP ' + response.status);
                $('#sce-app-' + id).css('color', successColour);
            } catch (err) {
                statusMsg('Failed to ' + action + ' app ' + id + ': ' + err.message);
            }
            await sleep(1500);
        }
        statusMsg('Finished ' + (action === 'add' ? 'adding' : 'removing') + ' all entries.');
    }

    // =========================================================================
    // ADD SYNCH COLUMNS TO TABLE (CO / PB / CN / CR)
    // =========================================================================

    async function addInventoryColumns(cardAmounts) {
        setVersionBtnState('updating');
        // Yield one animation frame so the browser repaints the button red
        // before the synchronous DOM work blocks further painting.
        await sleep(50);
        dtDestroy(TABLE_ID);

        $('#' + TABLE_ID + ' tbody tr').each(function () {
            const href = $(this).find('a[href*="inventorygame-appid-"]').attr('href') || '';
            const appId = href.substring(href.lastIndexOf('-') + 1);
            const setSize = parseInt($(this).find('td').eq(COL_SETSIZE).text(), 10) || 0;
            const owned = cardAmounts[appId] || 0;
            const badgesPossible = setSize > 0 ? Math.floor(owned / setSize) : 0;
            const remainder = owned - (badgesPossible * setSize);
            const cardsNeeded = setSize - remainder;
            const neededClass = cardsNeeded <= 3 ? 'needed' + cardsNeeded : '';
            $(this)
                .append('<td>' + owned + '</td>')
                .append('<td>' + badgesPossible + '</td>')
                .append('<td class="' + neededClass + '">' + cardsNeeded + '</td>')
                .append('<td>' + remainder + '</td>');
        });

        $('#' + TABLE_ID + ' thead tr')
            .append('<th class="w-14" title="Cards Owned: total Trading Cards for this game in your Steam inventory">C O</th>')
            .append('<th class="w-14" title="Possible Badges: number of Badges you can craft right now (if you have one of each card, otherwise trade first)">P B</th>')
            .append('<th class="w-14" title="Cards Needed: cards still needed to reach one more complete Badge">C N</th>')
            .append('<th class="w-14" title="Cards Remaining: leftover cards after crafting all the Badges you can">C R</th>');

        reinitDataTable(TABLE_ID, COL_SW, 'asc', [[COL_CN, 'asc']], [
            { type: 'num', targets: [COL_SYNCH_START, COL_SYNCH_START + 1, COL_SYNCH_START + 2, COL_SYNCH_START + 3] }
        ]);

        setVersionBtnState('ready');
        console.log('SCE Tools: inventory columns added.');
    }


    // =========================================================================
    // =========================================================================
    // TRADE PAGE INJECTOR
    //
    // Runs only on steamcommunity.com/tradeoffer/new/* pages.
    // Reads sce_trade=ID from the URL, loads trade data from GM_getValue,
    // then uses Steam's own internal JavaScript objects to add items:
    //
    //   unsafeWindow.UserYou   – your inventory data and context
    //   unsafeWindow.UserThem  – the bot's inventory data and context
    //   unsafeWindow.MoveItemToTrade(element) – Steam's function to move an
    //                            item into the active trade slot
    //
    // This is the same approach used by the STM userscript. It avoids polling
    // for DOM element IDs (which never appear until a tab is manually clicked)
    // and instead works directly with Steam's loaded inventory data.
    //
    // After injection the script monitors for the trade being sent and closes
    // the tab automatically.
    // =========================================================================
    // =========================================================================

    async function initTradeInjector() {
        const params = new URLSearchParams(window.location.search);
        const tradeId = params.get('sce_trade');
        if (!tradeId) return;

        const stored = GM_getValue('sce_trade_' + tradeId, null);
        if (!stored) return;

        let tradeData;
        try { tradeData = JSON.parse(stored); } catch (_) { GM_deleteValue('sce_trade_' + tradeId); return; }

        // ── INTENT LOG – runs immediately, regardless of whether inventories load ──
        console.log('SCE Tools [TRADE]: script loaded, tradeId=' + tradeId);
        console.log('SCE Tools [TRADE]: type=' + tradeData.type
            + (tradeData.gameName ? ', game="' + tradeData.gameName + '"' : '')
            + (tradeData.appId   ? ', appId=' + tradeData.appId : ''));
        if (tradeData.type === 'get') {
            const items = tradeData.items || [];
            console.log('SCE Tools [INTENT GET]: requesting ' + items.length + ' card(s) from bot:');
            items.forEach(function (item, i) {
                console.log('  [' + (i + 1) + '] "' + item.name + '"'
                    + ' (norm: "' + normalizeName(item.name) + '")');
            });
            if (tradeData.giveItems && tradeData.giveItems.length > 0) {
                const giveTotal = tradeData.giveItems.reduce(function (s, g) { return s + g.count; }, 0);
                console.log('SCE Tools [INTENT GET+GIVE]: also selling ' + giveTotal + ' surplus card(s) in the same trade:');
                tradeData.giveItems.forEach(function (g) {
                    console.log('  -> "' + g.name + '" x' + g.count);
                });
            }
        } else if (tradeData.type === 'give') {
            const qualifying = (tradeData.sceCards || []).filter(function (c) { return c.stock < 8; });

            console.log('SCE Tools [INTENT GIVE]: maxCardsUnderCreditLimit=' + tradeData.maxCardsUnderCreditLimit
                + ', appId=' + tradeData.appId);
            console.log('SCE Tools [INTENT GIVE]: qualifying bot slots (' + qualifying.length + '):');
            qualifying.forEach(function (c) {
                console.log('  -> "' + c.name + '" (norm: "' + normalizeName(c.name)
                    + '", stock: ' + c.stock + ', capacity: ' + (8 - c.stock) + ')');
            });
        }
        // ─────────────────────────────────────────────────────────────────────────

        const cardCount = tradeData.type === 'get'  ? (tradeData.items || []).length
                        : tradeData.type === 'give' ? ('up to ' + (tradeData.maxCardsUnderCreditLimit || '?'))
                        : 0;
        const giveAlongsideCount = (tradeData.type === 'get' && tradeData.giveItems)
            ? tradeData.giveItems.reduce(function (s, g) { return s + g.count; }, 0) : 0;
        const direction = tradeData.type === 'give' ? 'giving' : 'getting';
        const sellSuffix = giveAlongsideCount > 0 ? ' and selling ' + giveAlongsideCount + ' surplus card(s)' : '';
        const gameRef = tradeData.gameName ? ' from ' + tradeData.gameName : '';

        // Status bar – wrap all creation and updates in STATUS_BAR_ENABLED so
        // it can be toggled off for testing without touching any other code.
        let statusBar = null;
        if (STATUS_BAR_ENABLED) {
            statusBar = document.createElement('div');
            statusBar.style.cssText =
                'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b07800;' +
                'color:#fff;text-align:center;padding:6px;font-size:13px;font-weight:bold;';
            statusBar.textContent = 'SCE Tools (v' + SCRIPT_VERSION + '): ' + direction + ' ' + cardCount + ' card(s)' + sellSuffix + gameRef + ' \u2013 loading inventories\u2026';
            document.body.appendChild(statusBar);
        }

        function setStatus(text, bg) {
            if (!statusBar) return;
            statusBar.textContent = text;
            if (bg) statusBar.style.background = bg;
        }

        // Fades the bar out after 5 seconds – used only for non-error outcomes.
        // Error bars are left visible permanently so they are never missed.
        // Clear the last-inventory-context cookie so Steam does not pre-load
        // the wrong inventory tab. Restore it afterwards (same as STM does).
        const oldCookie = (document.cookie.split('strTradeLastInventoryContext=')[1] || '').split(';')[0];
        document.cookie = 'strTradeLastInventoryContext=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/tradeoffer/';

        function restoreCookie() {
            if (oldCookie) {
                const exp = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toUTCString();
                document.cookie = 'strTradeLastInventoryContext=' + oldCookie + '; expires=' + exp + '; path=/tradeoffer/';
            }
        }

        try {
            const users = await waitForBothInventories(tradeData.type);

            if (tradeData.type === 'get') {
                setStatus('SCE Tools (v' + SCRIPT_VERSION + '): adding ' + tradeData.items.length + ' item(s) to Trading Card Exchange [BOT]\u2019s Items\u2026', '#1a9fff');
                await injectGetItems(tradeData, users.UserThem);
                if (tradeData.giveItems && tradeData.giveItems.length > 0) {
                    setStatus('SCE Tools (v' + SCRIPT_VERSION + '): also adding ' + giveAlongsideCount + ' surplus card(s) to Your Items\u2026', '#1a9fff');
                    await injectGiveSpecificItems(tradeData.giveItems, tradeData.appId, users.UserYou);
                }
            } else if (tradeData.type === 'give') {
                // Pre-scan the loaded inventory so the status bar shows the exact
                // give count rather than the credit-cap upper bound.
                const givePreview = countGiveableFromInventory(tradeData, users.UserYou);
                const creditSkipped = givePreview.totalAvailable - givePreview.willGive;
                const gameLabel = tradeData.gameName ? ' from ' + tradeData.gameName : '';
                const skipNote = creditSkipped > 0
                    ? ' (' + creditSkipped + ' card' + (creditSkipped === 1 ? '' : 's')
                        + ' cannot be given due to 100c credit limit)'
                    : '';
                setStatus('SCE Tools (v' + SCRIPT_VERSION + '): giving '
                    + givePreview.willGive + ' card(s)' + gameLabel + skipNote + '\u2026', '#1a9fff');
                const gaveCount = await injectGiveItems(tradeData, users.UserYou);
                if (gaveCount === 0) {
                    throw new Error(
                        'No matching cards found in your trade inventory. ' +
                        'Card names on the trade page did not match the SCE page. ' +
                        'Please add cards manually.'
                    );
                }
                setStatus('SCE Tools (v' + SCRIPT_VERSION + '): added ' + gaveCount + ' card(s) to Your Items \u2013 review and confirm.');
            }

            // Show your inventory in the trade UI after injecting.
            unsafeWindow.TradePageSelectInventory(users.UserYou, 753, '6');
            restoreCookie();

            const afterTradeNote =
                CFG.actionAfterTrade === 'close' ? 'Tab closes automatically after sending.'
                : CFG.actionAfterTrade === 'ok'  ? 'Tab will open the trade recap page after sending.'
                : 'This tab will remain open after sending \u2014 review and confirm manually.';
            setStatus('SCE Tools (v' + SCRIPT_VERSION + '): done \u2013 review and confirm the trade. ' + afterTradeNote);
            GM_deleteValue('sce_trade_' + tradeId);

            // Whichever happens first wins: the trade completes normally (no
            // mobile confirmation needed), or the "Additional confirmation
            // needed" dialog appears. Either way we've detected the trade was
            // sent; what happens next depends on CFG.actionAfterTrade — see
            // clickTradeOkButton for the 'ok' case, which mirrors STM's own
            // "Click OK" option (clicking Steam's own success-modal button
            // rather than reimplementing the redirect ourselves).
            const sent = await Promise.race([
                monitorForTradeSuccess(),
                watchForAdditionalConfirmation()
            ]);
            if (sent) {
                const stillPendingConfirmation = /additional\s+confirmation\s+needed/i.test(
                    document.body ? document.body.innerText : ''
                );

                if (CFG.actionAfterTrade === 'none') {
                    setStatus(
                        'SCE Tools (v' + SCRIPT_VERSION + '): '
                        + (stillPendingConfirmation
                            ? 'trade offer pending mobile confirmation.'
                            : 'trade sent.'),
                        '#1a7f3c'
                    );
                } else if (CFG.actionAfterTrade === 'ok') {
                    if (stillPendingConfirmation) {
                        // No success modal exists yet — the offer isn't
                        // actually sent until confirmed on the phone, so
                        // there's no recap page to open. Leave the tab open
                        // rather than guessing at an action.
                        setStatus(
                            'SCE Tools (v' + SCRIPT_VERSION + '): trade offer pending mobile '
                            + 'confirmation \u2014 no recap page to open yet, leaving tab open.',
                            '#1a7f3c'
                        );
                    } else {
                        const clicked = clickTradeOkButton();
                        setStatus(
                            'SCE Tools (v' + SCRIPT_VERSION + '): '
                            + (clicked
                                ? 'trade sent \u2013 opening recap page\u2026'
                                : 'trade sent, but could not find the OK button \u2014 leaving tab open.'),
                            '#1a7f3c'
                        );
                    }
                } else {
                    // 'close' (default) — matches the previous behaviour.
                    setStatus(
                        'SCE Tools (v' + SCRIPT_VERSION + '): '
                        + (stillPendingConfirmation
                            ? 'trade offer pending mobile confirmation \u2013 closing tab\u2026'
                            : 'trade sent \u2013 closing tab\u2026'),
                        '#1a7f3c'
                    );
                    await sleep(1500);
                    window.close();
                }
            } else {
                // 3-minute window expired without a trade being sent — leave
                // the status bar visible so the user can see the last message.
            }
        } catch (err) {
            restoreCookie();
            GM_deleteValue('sce_trade_' + tradeId);
            // Error bar stays visible permanently – never faded – so it can't be missed.
            setStatus('SCE Tools (v' + SCRIPT_VERSION + ') error: ' + err.message, '#c0392b');
            console.error('SCE Tools [trade injector]:', err);
        }
    }

    // Waits for unsafeWindow.UserYou and UserThem to exist, then polls until
    // both Steam (753) context-6 inventories are loaded.
    //
    // Key behaviours that make this reliable:
    //
    // 1. TradePageSelectInventory is called once to establish the context and
    //    kick off the initial load of the bot's inventory.
    //
    // 2. loadInventory is called every RETRY_INTERVAL ms on any user whose
    //    inventory is still missing and not currently in flight.  Steam often
    //    returns "inventory unavailable" silently (cLoadsInFlight drops to 0
    //    but inventory stays null); without periodic retries we time out.
    //    This mirrors exactly what the STM userscript does.
    //
    // 3. A visibilitychange listener immediately re-triggers loading when the
    //    user switches to this tab.  Chrome throttles setTimeout in background
    //    tabs to ~1 s minimum, so the effective retry rate in the background
    //    can be much lower than the nominal RETRY_INTERVAL; switching to the
    //    tab is the fastest way to unblock a stalled load.
    //
    // 4. Sleep is 1 second (not 500 ms) to be realistic about background-tab
    //    throttling – a shorter value is aspirational, not actual.
    //
    // 5. Total deadline is 90 seconds to allow for genuinely slow inventories
    //    (the SCE bot has ~3 500 items; some bots exceed 10 000).
    async function waitForBothInventories(tradeType) {
        const deadline = Date.now() + 90000;

        // Phase 1: wait for Steam's user objects to appear in the page scope.
        while (Date.now() < deadline) {
            if (typeof unsafeWindow.UserYou !== 'undefined' &&
                typeof unsafeWindow.UserThem !== 'undefined') break;
            await sleep(500);
        }
        if (typeof unsafeWindow.UserYou === 'undefined') {
            throw new Error(
                'Steam UserYou / UserThem objects not found. ' +
                'The trade page may have changed its internal API.'
            );
        }

        const UserYou = unsafeWindow.UserYou;
        const UserThem = unsafeWindow.UserThem;

        // Phase 2: trigger + poll until required inventories are populated.
        //
        // For GIVE trades, injectGiveItems only reads UserYou – we don't need
        // the bot's inventory at all.  Waiting for UserThem would block the
        // script even after the user manually loads their own inventory.
        // For GET trades, we need both (bot's inventory is the source of items).
        const needBotInventory = tradeType !== 'give';

        const RETRY_INTERVAL = 8000;
        let lastRetry = 0;
        let retryOnVisible = false;
        let retryNow = false; // set by manual "Your Inventory" click listener

        function onVisibilityChange() {
            if (!document.hidden) retryOnVisible = true;
        }
        document.addEventListener('visibilitychange', onVisibilityChange);

        // When the user manually clicks the "Your Inventory" tab in the trade UI,
        // Steam calls TradePageSelectInventory → loadInventory.  We listen for
        // this so we can immediately poll for the result instead of waiting up
        // to 250 ms for the next scheduled poll.
        function onYourInventoryTabClick() { retryNow = true; }
        const yourInvTab = document.getElementById('inventory_select_your_inventory');
        if (yourInvTab) yourInvTab.addEventListener('click', onYourInventoryTabClick);

        // Helper: attempt to (re)load one user's inventory.
        // Prefers the direct loadInventory call (same as STM) when the context
        // already exists; falls back to TradePageSelectInventory otherwise.
        function triggerLoad(user) {
            try {
                var ctx = user.rgContexts && user.rgContexts[753] && user.rgContexts[753][6];
                if (ctx) {
                    user.loadInventory(753, 6);
                } else {
                    unsafeWindow.TradePageSelectInventory(user, 753, '6');
                }
            } catch (_) {
                try { unsafeWindow.TradePageSelectInventory(user, 753, '6'); } catch (_) {}
            }
        }

        // Initial trigger to get the bot's inventory loading (GET only).
        //
        // STM deliberately waits 500ms after its own setup before its first
        // inventory check (window.setTimeout(checkContexts, 500, ...)) rather
        // than firing immediately. We previously had no equivalent delay —
        // @run-at document-idle means this could fire within milliseconds of
        // the trade page becoming interactive, far faster than any human
        // click or STM's own first attempt. An unnaturally instant automated
        // request is a known pattern anti-abuse heuristics watch for,
        // independent of overall request volume — which would explain 429s
        // persisting even after a long idle period with no other script
        // activity (queue-collision alone can't explain that). Waiting a
        // similar amount before the first attempt costs nothing meaningful
        // (trades already take much longer than this) and matches what's
        // empirically known to work reliably.
        await sleep(750);
        if (needBotInventory) {
            triggerLoad(UserThem);
        }
        lastRetry = Date.now();

        // Steam's "This inventory is not available at this time. Please try
        // again later." message is rendered into a single SHARED page element
        // — it looks identical regardless of which side (yours or theirs) is
        // actually failing, so the text alone can't tell us which one it is.
        // We already know that independently from our own polling state
        // (youReady / themReady), so we use THAT to decide which side the
        // message applies to.
        //
        // Empirically (per user reports), retrying "Your Inventory" sometimes
        // recovers this error, but retrying "Their Inventory" for a heavily-
        // traded bot essentially never does. We can't verify Steam's internal
        // rate-limiting architecture to prove this, but it's consistent with
        // the bot's inventory endpoint being hit far more often by concurrent
        // traders than an individual's own inventory. Rather than burning the
        // full 90-second deadline on a wait that's very unlikely to resolve,
        // we give the bot's side one full retry cycle after first seeing the
        // message, then abort early with a clear explanation.
        const NOT_AVAILABLE_RE = /this inventory is not available at this time/i;
        const THEM_UNAVAILABLE_GRACE_MS = 15000;
        // Steam's own client appears to retry internally on a 429 flood,
        // which can make the "not available" DOM text flicker in and out
        // between polls. A brief absence shouldn't reset the grace-period
        // clock back to zero — only treat it as genuinely cleared if it's
        // been absent for a meaningful continuous stretch.
        const THEM_UNAVAILABLE_FLICKER_TOLERANCE_MS = 3000;
        let themRetryCount = needBotInventory ? 1 : 0; // the initial trigger above counts as attempt #1
        let themUnavailableFirstSeenAt = null;
        let themUnavailableLastSeenAt = null;

        try {
            while (Date.now() < deadline) {
                var youCtx = UserYou.rgContexts && UserYou.rgContexts[753] && UserYou.rgContexts[753][6];
                var themCtx = UserThem.rgContexts && UserThem.rgContexts[753] && UserThem.rgContexts[753][6];

                var youReady = youCtx && youCtx.inventory && UserYou.cLoadsInFlight === 0;
                var themReady = themCtx && themCtx.inventory && UserThem.cLoadsInFlight === 0;

                var allReady = needBotInventory ? (youReady && themReady) : youReady;
                if (allReady) return { UserYou: UserYou, UserThem: UserThem };

                if (needBotInventory && !themReady) {
                    var bodyText = document.body ? document.body.innerText : '';
                    var nowTs = Date.now();
                    if (NOT_AVAILABLE_RE.test(bodyText)) {
                        if (themUnavailableFirstSeenAt === null) {
                            themUnavailableFirstSeenAt = nowTs;
                            console.warn('SCE Tools: "inventory not available" seen while waiting for '
                                + 'the bot\'s inventory (retry #' + themRetryCount + '). Will give up after '
                                + (THEM_UNAVAILABLE_GRACE_MS / 1000) + 's if it doesn\'t clear.');
                        }
                        themUnavailableLastSeenAt = nowTs;
                        if ((nowTs - themUnavailableFirstSeenAt) > THEM_UNAVAILABLE_GRACE_MS) {
                            throw new Error(
                                'The other party\u2019s inventory reported "not available" and did not '
                                + 'recover after a retry. This side very rarely recovers once this '
                                + 'happens (your own inventory sometimes does \u2014 the other party\u2019s '
                                + 'essentially never does, in our experience) \u2014 cancelling this trade '
                                + 'early rather than waiting the full 90 seconds.'
                            );
                        }
                    } else if (themUnavailableFirstSeenAt !== null
                        && (nowTs - themUnavailableLastSeenAt) > THEM_UNAVAILABLE_FLICKER_TOLERANCE_MS) {
                        // Genuinely gone for a meaningful stretch, not just a
                        // momentary flicker — give it a fresh chance.
                        themUnavailableFirstSeenAt = null;
                        themUnavailableLastSeenAt = null;
                    }
                }

                // Retry when: user clicked Your Inventory, tab became visible,
                // or RETRY_INTERVAL has elapsed.
                if (retryNow || retryOnVisible || (Date.now() - lastRetry > RETRY_INTERVAL)) {
                    retryNow = false;
                    retryOnVisible = false;
                    lastRetry = Date.now();
                    if (!youReady && UserYou.cLoadsInFlight === 0) triggerLoad(UserYou);
                    if (needBotInventory && !themReady && UserThem.cLoadsInFlight === 0) {
                        triggerLoad(UserThem);
                        themRetryCount++;
                    }
                }

                // Let the SCE page's precompute queues (B/L and S buttons)
                // know a trade tab is actively loading inventories, so they
                // can pause rather than adding to Steam's rate-limit load
                // while this is in progress. See TRADE_LOADING_HEARTBEAT_KEY.
                GM_setValue(TRADE_LOADING_HEARTBEAT_KEY, Date.now());

                // 250 ms is fine in a foreground tab; fast enough to pick up the
                // inventory within a quarter-second of the user clicking Your Inventory.
                await sleep(250);
            }
        } finally {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            if (yourInvTab) yourInvTab.removeEventListener('click', onYourInventoryTabClick);
            GM_deleteValue(TRADE_LOADING_HEARTBEAT_KEY);
        }

        throw new Error(
            'Trade inventories did not finish loading within 90 seconds. ' +
            'Steam may be rate-limiting or the inventory may be temporarily unavailable.'
        );
    }

    // Pre-counts how many cards would be given in a GIVE trade without
    // actually moving any items.  Returns { willGive, totalAvailable } where:
    //   willGive       = cards that will be selected (limited by maxCardsUnderCreditLimit)
    //   totalAvailable = cards that COULD be given ignoring the credit cap (still capped at 6)
    // Calling this before injectGiveItems lets us show an accurate status message.
    function countGiveableFromInventory(tradeData, UserYou) {
        const inv = UserYou.rgContexts[753][6].inventory;
        inv.BuildInventoryDisplayElements();
        const rgInv = inv.rgInventory;

        const appId = String(tradeData.appId || '');
        const limit = tradeData.maxCardsUnderCreditLimit || 6;
        const sceCards = (tradeData.sceCards || [])
            .filter(function (c) { return c.stock < 8; })
            .sort(function (a, b) { return b.stock - a.stock; });

        var willGive = 0, totalAvailable = 0;
        var usedIds = new Set();

        for (var i = 0; i < sceCards.length; i++) {
            if (totalAvailable >= 6) break; // absolute per-trade max
            var card = sceCards[i];
            var targetName = normalizeName(card.name);
            var botCapacity = 8 - card.stock;
            var taken = 0;
            var assetIds = Object.keys(rgInv);
            for (var j = 0; j < assetIds.length; j++) {
                if (totalAvailable >= 6 || taken >= botCapacity) break;
                var aid = assetIds[j];
                if (usedIds.has(aid)) continue;
                var item = rgInv[aid];
                if (!item) continue;
                if (appId && item.market_fee_app && String(item.market_fee_app) !== appId) continue;
                if (item.type && item.type.includes('Foil')) continue;
                if (normalizeName(item.name || '') !== targetName) continue;
                usedIds.add(aid);
                taken++;
                totalAvailable++;
                if (willGive < limit) willGive++;
            }
        }

        return { willGive: willGive, totalAvailable: totalAvailable };
    }

    // Adds items from the bot's inventory to "Their Items" by matching card
    // names against Steam's internal inventory data for UserThem.
    // Filtering by market_fee_app === appId prevents cross-game name collisions
    // (e.g. Left 4 Dead 2 "Charger" being selected instead of Mount & Blade: Warband "Charger").
    async function injectGetItems(tradeData, UserThem) {
        const items = tradeData.items || [];
        const appId = tradeData.appId ? String(tradeData.appId) : null;

        const inv = UserThem.rgContexts[753][6].inventory;
        inv.BuildInventoryDisplayElements();
        const rgInv = inv.rgInventory;

        console.log('SCE Tools [GET]: bot inventory size:', Object.keys(rgInv).length, 'item(s)',
            appId ? '(filtering to appId=' + appId + ')' : '(no appId filter)');
        console.log('SCE Tools [GET]: items to request (' + items.length + '):');
        items.forEach(function (item) {
            console.log('  -> "' + item.name + '" (norm: "' + normalizeName(item.name) + '")');
        });

        // Build a map: normalizedName -> [bot items with that name FROM THIS GAME]
        const byName = {};
        Object.keys(rgInv).forEach(function (assetId) {
            const item = rgInv[assetId];
            // Skip items from the wrong game when appId is known.
            if (appId && item.market_fee_app && String(item.market_fee_app) !== appId) return;
            const key = normalizeName(item.name || '');
            if (!byName[key]) byName[key] = [];
            byName[key].push(item);
        });

        let moved = 0;
        for (let i = 0; i < items.length; i++) {
            const target = items[i];
            const key = normalizeName(target.name);
            const pool = byName[key] || [];
            if (pool.length > 0) {
                unsafeWindow.MoveItemToTrade(pool.shift().element);
                console.log('  [GET] moved "' + target.name + '"');
                moved++;
                await sleep(100);
            } else {
                console.warn('  [GET] NOT FOUND in bot inventory: "' + target.name + '" (key: "' + key + '")');
            }
        }
        console.log('SCE Tools [GET]: done – moved ' + moved + ' / ' + items.length + ' item(s)');
    }

    // Adds the user's cards for the give trade to "Your Items" by matching
    // card names from the SCE game page against the live Steam trade-page
    // inventory names (item.name in UserYou.rgContexts[753][6].inventory).
    //
    // Both name sources come from Steam's own servers so they are consistent
    // with each other, avoiding the cross-source mismatch that plagued the
    // previous approach of storing names from the inventory API during SYNCH
    // and comparing them to SCE page names at trade time.
    //
    // Returns the number of items actually moved to the trade.
    // Moves a fixed, precomputed list of { name, count } cards from UserYou's
    // trade-page inventory to "Your Items" — used for the L button's optional
    // give-alongside-buy: selling exact surplus duplicates in the same trade
    // as buying missing cards. Unlike injectGiveItems (which derives its own
    // selection from the bot's qualifying stock), this moves exactly what was
    // already decided by computeGiveAlongsideBuy at precompute time.
    async function injectGiveSpecificItems(giveItems, appId, UserYou) {
        const inv = UserYou.rgContexts[753][6].inventory;
        inv.BuildInventoryDisplayElements();
        const rgInv = inv.rgInventory;

        console.log('SCE Tools [GET+GIVE]: user inventory size:', Object.keys(rgInv).length, 'item(s)');
        console.log('SCE Tools [GET+GIVE]: items to give (' + giveItems.length + ' type(s)):');
        giveItems.forEach(function (g) { console.log('  -> "' + g.name + '" x' + g.count); });

        const usedAssetIds = new Set();
        let moved = 0;

        for (let i = 0; i < giveItems.length; i++) {
            const targetName = normalizeName(giveItems[i].name);
            let taken = 0;
            const assetIds = Object.keys(rgInv);
            for (let j = 0; j < assetIds.length && taken < giveItems[i].count; j++) {
                const aid = assetIds[j];
                if (usedAssetIds.has(aid)) continue;
                const item = rgInv[aid];
                if (!item || !item.element) continue;
                if (!item.market_fee_app || String(item.market_fee_app) !== String(appId)) continue;
                if (item.type && item.type.includes('Foil')) continue;
                if (normalizeName(item.name || '') !== targetName) continue;
                usedAssetIds.add(aid);
                unsafeWindow.MoveItemToTrade(item.element);
                console.log('  [GET+GIVE] moved "' + item.name + '"');
                moved++;
                taken++;
                await sleep(100);
            }
            if (taken < giveItems[i].count) {
                console.warn('  [GET+GIVE] only found ' + taken + '/' + giveItems[i].count
                    + ' of "' + giveItems[i].name + '" in your live inventory');
            }
        }
        console.log('SCE Tools [GET+GIVE]: done \u2013 moved ' + moved + ' give item(s)');
        return moved;
    }

    async function injectGiveItems(tradeData, UserYou) {
        const appId = String(tradeData.appId || '');
        const sceCards = tradeData.sceCards || [];
        const maxCardsUnderCreditLimit = tradeData.maxCardsUnderCreditLimit || 6;

        const inv = UserYou.rgContexts[753][6].inventory;
        inv.BuildInventoryDisplayElements();
        const rgInv = inv.rgInventory;

        console.log('SCE Tools [GIVE]: appId=' + appId + ', maxCardsUnderCreditLimit=' + maxCardsUnderCreditLimit);
        console.log('SCE Tools [GIVE]: user inventory size:', Object.keys(rgInv).length, 'item(s)');

        // Bot's qualifying card types, sorted by highest stock first (give the
        // cards the bot already has most of, so we clear common ones first).
        const qualifyingCards = sceCards
            .filter(function (c) { return c.stock < 8; })
            .sort(function (a, b) { return b.stock - a.stock; });

        console.log('SCE Tools [GIVE]: qualifying bot card types (' + qualifyingCards.length + '):');
        qualifyingCards.forEach(function (c) {
            console.log('  -> "' + c.name + '" (norm: "' + normalizeName(c.name) + '", stock: ' + c.stock + ', capacity: ' + (8 - c.stock) + ')');
        });

        const selected = [];
        const usedAssetIds = new Set();

        for (var i = 0; i < qualifyingCards.length; i++) {
            if (selected.length >= maxCardsUnderCreditLimit) break;
            var targetName = normalizeName(qualifyingCards[i].name);
            var botCapacity = 8 - qualifyingCards[i].stock;
            var taken = 0;

            var assetIds = Object.keys(rgInv);
            for (var j = 0; j < assetIds.length; j++) {
                if (selected.length >= maxCardsUnderCreditLimit || taken >= botCapacity) break;
                var aid = assetIds[j];
                if (usedAssetIds.has(aid)) continue;
                var item = rgInv[aid];
                if (!item || !item.element) continue;
                // Skip items from a different game – card names like "Drone"
                // appear in multiple sets, so appId is the required tiebreaker.
                if (!item.market_fee_app || String(item.market_fee_app) !== String(appId)) continue;
                // Skip foil cards.
                if (item.type && item.type.includes('Foil')) continue;
                if (normalizeName(item.name || '') === targetName) {
                    selected.push(item);
                    usedAssetIds.add(aid);
                    taken++;
                }
            }
        }

        console.log('SCE Tools [GIVE]: selected ' + selected.length + ' card(s) to move:');
        selected.forEach(function (item) {
            console.log('  -> "' + item.name + '" (appId: ' + item.market_fee_app + ', type: ' + item.type + ')');
        });

        for (var k = 0; k < selected.length; k++) {
            unsafeWindow.MoveItemToTrade(selected[k].element);
            await sleep(100);
        }

        console.log('SCE Tools [GIVE]: done – moved ' + selected.length + ' item(s)');
        return selected.length;
    }

    // Clicks Steam's own success-modal "OK" button, the same element STM's
    // "Click OK" option targets. This is only meaningful once a trade has
    // actually been sent (not just pending mobile confirmation) — Steam
    // shows this modal after a normal, non-mobile-confirmed send, and
    // clicking it is what normally triggers Steam's own redirect to the
    // trade offers recap page. Returns true if a button was found and clicked.
    function clickTradeOkButton() {
        const btn = document.querySelector('div.newmodal_buttons > div, div.newmodal_buttons button');
        if (btn) { btn.click(); return true; }
        return false;
    }

    // Watches for Steam's "Additional confirmation needed" dialog, which
    // appears when the trade requires Steam Mobile App confirmation (e.g.
    // trading with an account you're not friends with, like the SCE bot).
    //
    // We do NOT wait for the user to actually confirm on their phone — as
    // soon as this dialog appears, it counts as "sent" for the purposes of
    // CFG.actionAfterTrade (matching STM's behaviour for its own "close
    // window" option). The user can confirm the trade on their phone
    // whenever they like (immediately, or after queuing up several more
    // trades first); Steam keeps the trade offer pending until they do.
    function watchForAdditionalConfirmation() {
        return new Promise(function (resolve) {
            const observer = new MutationObserver(function () {
                const titleEls = document.querySelectorAll('.title_text');
                for (var i = 0; i < titleEls.length; i++) {
                    if (/additional\s+confirmation\s+needed/i.test(titleEls[i].textContent)) {
                        observer.disconnect();
                        console.log('SCE Tools: mobile confirmation dialog detected \u2014 closing tab.');
                        resolve(true);
                        return;
                    }
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    // Resolves true on success, false if the user does not confirm within 3 min.
    function monitorForTradeSuccess() {
        return new Promise(function (resolve) {
            const giveUpAt = Date.now() + 180000;

            function check() {
                const text = document.body ? document.body.innerText : '';
                if (/offer has been sent/i.test(text)) {
                    observer.disconnect();
                    resolve(true);
                    return;
                }
                if (new URLSearchParams(window.location.search).has('tradeid')) {
                    observer.disconnect();
                    resolve(true);
                    return;
                }
                if (Date.now() > giveUpAt) {
                    observer.disconnect();
                    resolve(false);
                }
            }

            const observer = new MutationObserver(check);
            observer.observe(document.body, { childList: true, subtree: true });

            const poll = setInterval(function () {
                if (new URLSearchParams(window.location.search).has('tradeid') || Date.now() > giveUpAt) {
                    clearInterval(poll);
                    observer.disconnect();
                    resolve(Date.now() <= giveUpAt);
                }
            }, 1000);
        });
    }


    // =========================================================================
    // SHARED UTILITIES
    // =========================================================================

    // Returns the user's current SCE credit balance by reading the "Xc" display
    // from the top-right navigation button.  Returns null if not found.
    function getCurrentCredits() {
        const els = document.querySelectorAll('.ml-auto');
        for (var i = 0; i < els.length; i++) {
            var m = els[i].textContent.trim().match(/^(\d+)c$/);
            if (m) return parseInt(m[1], 10);
        }
        return null;
    }

    // Removes any sce_trade_* keys from GM storage that are older than six hours.
    // Called once on SCE page load.  Trade keys are never deleted if the trade
    // tab is closed before injection completes, so they accumulate over time.
    function cleanupOldTrades() {
        try {
            var keys = GM_listValues();
            var cutoff = Date.now() - 6 * 3600 * 1000;
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                if (key.indexOf('sce_trade_') !== 0) continue;
                // Key format: sce_trade_{timestamp}_{random}
                var parts = key.split('_');
                var ts = parseInt(parts[2] || '0', 10);
                if (ts && ts < cutoff) {
                    GM_deleteValue(key);
                    console.log('SCE Tools: removed stale trade key', key);
                }
            }
        } catch (err) {
            console.warn('SCE Tools: trade cleanup failed:', err.message);
        }
    }

    // Wraps GM_xmlhttpRequest in a Promise.
    // raw: true  → resolves with response text (use for HTML pages).
    // raw: false → resolves with parsed JSON (default).
    function gmFetch(url, options) {
        options = options || {};
        const headers = options.headers || {};
        const raw = options.raw || false;

        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                headers: headers,
                timeout: 15000,
                onload: function (response) {
                    if (response.status === 401) {
                        reject(new Error('Steam says you are not logged in (HTTP 401). Log into Steam Community and Store (these are not the same) and try again.'));
                        return;
                    }
                    if (response.status === 403) {
                        reject(new Error('Steam denied access (HTTP 403). Your inventory may be set to Private.'));
                        return;
                    }
                    if (response.status === 429) {
                        reject(new Error('Steam rate-limited this request (HTTP 429). Wait a minute and try again.'));
                        return;
                    }
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error('HTTP ' + response.status + ' from ' + url));
                        return;
                    }
                    if (raw) {
                        resolve(response.responseText);
                        return;
                    }
                    try {
                        resolve(JSON.parse(response.responseText));
                    } catch (e) {
                        reject(new Error('Could not parse JSON from ' + url + '. First 120 chars: ' + response.responseText.substring(0, 120)));
                    }
                },
                onerror: function (r) {
                    reject(new Error('Network error fetching ' + url + ': ' + (r.statusText || 'unknown')));
                },
                ontimeout: function () {
                    reject(new Error('Request timed out: ' + url));
                }
            });
        });
    }

    // Returns cached Steam ID from GM_getValue (written during SYNCH) or
    // resolves it fresh and caches it. Needed for trade buttons on the
    // Inventory page where SYNCH has not been run.
    async function getSteamIdCached() {
        const cached = GM_getValue('sce_steamId', null);
        if (cached) return cached;
        const steamId = await getSteamId();
        GM_setValue('sce_steamId', steamId);
        return steamId;
    }

    // Normalises a card name for reliable comparison across SCE and Steam pages.
    // Normalises a card name so names from different sources (Steam inventory
    // API, SCE page, Steam gamecards page) all compare equal.
    //
    // Steam appends " (Trading Card)" or " (Foil Trading Card)" to the
    // market_name whenever the base card name would collide with another
    // tradeable item type in the same game (e.g. an emoticon named "Bouncer"
    // alongside the "Bouncer (Trading Card)" card).  SCE strips this suffix and
    // shows only the base name.  We strip it here so both sides normalise to
    // the same key, fixing SYNCH storage, the precompute cross-reference, and
    // injectGiveItems in one place.
    function normalizeName(name) {
        return name
            .normalize('NFC')
            .trim()
            .replace(/\s+/g, ' ')
            .toLowerCase()
            .replace(/\s*\(foil trading card\)\s*$/, '')
            .replace(/\s*\(trading card\)\s*$/, '');
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

})();
