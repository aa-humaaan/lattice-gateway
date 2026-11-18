import { ICONS, PROVIDER_LOGOS } from './icons';

export function getDashboardHtml(nonce?: string): string {
  const nonceAttr = nonce ? ` nonce="${nonce}"` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lattice Gateway — Mission Control</title>
  <style${nonceAttr}>
    /* Nonce-only CSP helpers: visibility and toast exit use classes, not CSSOM. */
    .lnl-hidden { display: none !important; }
    .lnl-show-block { display: block !important; }
    .lnl-show-inline-flex { display: inline-flex !important; }
    .lnl-toast-exit { opacity: 0; transform: translateY(8px); }
    :root {
      /* Warm Graphite / Zinc Obsidian Dark Palette */
      --bg-canvas: #09090b;
      --bg-surface: #121214;
      --bg-surface-elevated: #18181b;
      --bg-surface-hover: #222226;
      --bg-surface-active: #27272a;
      
      --border-subtle: #27272a;
      --border-muted: #3f3f46;
      --border-highlight: rgba(255, 255, 255, 0.12);

      --text-primary: #f4f4f5;
      --text-secondary: #a1a1aa;
      --text-tertiary: #71717a;

      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace;

      /* Status Colors */
      --emerald: #10b981;
      --emerald-text: #34d399;
      --emerald-bg: rgba(16, 185, 129, 0.1);
      --emerald-border: rgba(16, 185, 129, 0.25);

      --amber: #f59e0b;
      --amber-text: #fbbf24;
      --amber-bg: rgba(245, 158, 11, 0.1);
      --amber-border: rgba(245, 158, 11, 0.25);

      --coral: #f87171;
      --coral-text: #f87171;
      --coral-bg: rgba(248, 113, 113, 0.1);
      --coral-border: rgba(248, 113, 113, 0.25);

      --zinc: #71717a;
      --zinc-text: #a1a1aa;
      --zinc-bg: rgba(113, 113, 122, 0.1);
      --zinc-border: rgba(113, 113, 122, 0.25);

      --cyan: #06b6d4;
      --cyan-text: #38bdf8;
      --cyan-bg: rgba(6, 182, 212, 0.1);
      --cyan-border: rgba(6, 182, 212, 0.25);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100vh;
      overflow: hidden;
      background-color: var(--bg-canvas);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
    }

    body {
      display: flex;
    }

    /* Scrollbars */
    ::-webkit-scrollbar { width: 5px; height: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #27272a; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #3f3f46; }

    /* Sidebar Navigation */
    aside {
      width: 260px;
      background: var(--bg-surface);
      border-right: 1px solid var(--border-subtle);
      padding: 20px 16px;
      display: flex;
      flex-direction: column;
      gap: 18px;
      height: 100vh;
      flex-shrink: 0;
      overflow-y: auto;
      z-index: 40;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 0 4px 10px 4px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .brand-mark {
      width: 34px;
      height: 34px;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-muted);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--emerald-text);
      font-weight: 700;
      font-size: 1.1rem;
      flex-shrink: 0;
    }

    .brand-title {
      font-weight: 600;
      font-size: 1rem;
      color: var(--text-primary);
      letter-spacing: -0.01em;
    }

    .brand-subtitle {
      font-size: 0.72rem;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
    }

    nav {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .nav-section-title {
      font-size: 0.68rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-tertiary);
      padding: 8px 10px 4px;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 6px;
      color: var(--text-secondary);
      text-decoration: none;
      cursor: pointer;
      font-weight: 500;
      font-size: 0.85rem;
      transition: all 0.15s ease;
      border: 1px solid transparent;
      user-select: none;
    }

    .nav-item:hover {
      background: var(--bg-surface-elevated);
      color: var(--text-primary);
    }

    .nav-item.active {
      background: var(--bg-surface-elevated);
      color: var(--text-primary);
      border-color: var(--border-subtle);
    }

    .nav-item svg {
      color: var(--text-tertiary);
      flex-shrink: 0;
      transition: color 0.15s ease;
    }

    .nav-item:hover svg, .nav-item.active svg {
      color: var(--text-primary);
    }

    .nav-badge {
      margin-left: auto;
      font-size: 0.7rem;
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--zinc-bg);
      color: var(--zinc-text);
      border: 1px solid var(--zinc-border);
      font-family: var(--font-mono);
    }

    .nav-badge.emerald {
      background: var(--emerald-bg);
      color: var(--emerald-text);
      border-color: var(--emerald-border);
    }

    .sidebar-footer {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-top: 14px;
      border-top: 1px solid var(--border-subtle);
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 7px 12px;
      border-radius: 6px;
      font-size: 0.82rem;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s ease;
      text-decoration: none;
      white-space: nowrap;
      user-select: none;
    }

    .btn-primary {
      background: var(--text-primary);
      color: var(--bg-canvas);
      border-color: var(--text-primary);
    }

    .btn-primary:hover {
      background: #e4e4e7;
    }

    .btn-secondary {
      background: var(--bg-surface-elevated);
      color: var(--text-primary);
      border-color: var(--border-subtle);
    }

    .btn-secondary:hover {
      background: var(--bg-surface-hover);
      border-color: var(--border-muted);
    }

    .btn-emerald {
      background: var(--emerald-bg);
      color: var(--emerald-text);
      border-color: var(--emerald-border);
    }

    .btn-emerald:hover {
      background: rgba(16, 185, 129, 0.18);
    }

    .btn-danger {
      background: var(--coral-bg);
      color: var(--coral-text);
      border-color: var(--coral-border);
    }

    .btn-danger:hover {
      background: rgba(248, 113, 113, 0.18);
    }

    .btn-sm {
      padding: 4px 8px;
      font-size: 0.75rem;
    }

    /* Workspace / Main */
    main {
      flex: 1;
      height: 100vh;
      overflow-y: auto;
      background: var(--bg-canvas);
      display: flex;
      flex-direction: column;
    }

    .tab-view {
      display: none;
      padding: 24px 32px;
      max-width: 1400px;
      width: 100%;
      margin: 0 auto;
    }

    .tab-view.active {
      display: block;
    }

    .view-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      margin-bottom: 24px;
      gap: 16px;
    }

    .view-title-group h1 {
      font-size: 1.4rem;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.02em;
    }

    .view-title-group p {
      color: var(--text-secondary);
      font-size: 0.85rem;
      margin-top: 4px;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Status Pills */
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      border-radius: 9999px;
      font-size: 0.72rem;
      font-family: var(--font-mono);
      font-weight: 500;
      background: var(--zinc-bg);
      color: var(--zinc-text);
      border: 1px solid var(--zinc-border);
    }

    .status-pill.emerald {
      background: var(--emerald-bg);
      color: var(--emerald-text);
      border-color: var(--emerald-border);
    }

    .status-pill.amber {
      background: var(--amber-bg);
      color: var(--amber-text);
      border-color: var(--amber-border);
    }

    .status-pill.coral {
      background: var(--coral-bg);
      color: var(--coral-text);
      border-color: var(--coral-border);
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    .status-dot.pulse {
      animation: statusPulse 2s infinite;
    }

    @keyframes statusPulse {
      0% { opacity: 1; }
      50% { opacity: 0.3; }
      100% { opacity: 1; }
    }

    /* Card Panels */
    .panel {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 18px;
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }

    .kpi-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 14px;
      transition: border-color 0.15s ease;
    }

    .kpi-card:hover {
      border-color: var(--border-muted);
    }

    .kpi-label {
      font-size: 0.72rem;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 600;
    }

    .kpi-value {
      font-size: 1.35rem;
      font-weight: 600;
      color: var(--text-primary);
      margin: 6px 0 2px;
      font-family: var(--font-mono);
    }

    .kpi-subtext {
      font-size: 0.72rem;
      color: var(--text-secondary);
    }

    /* Hubs Grid */
    .hub-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 14px;
      margin-bottom: 24px;
    }

    .hub-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .hub-card:hover {
      border-color: var(--border-muted);
    }

    .hub-header {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .hub-icon {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary);
    }

    .hub-title {
      font-weight: 600;
      font-size: 0.95rem;
      color: var(--text-primary);
    }

    .hub-desc {
      font-size: 0.78rem;
      color: var(--text-secondary);
    }

    .hub-content {
      font-size: 0.8rem;
      color: var(--text-tertiary);
      line-height: 1.4;
      flex: 1;
    }

    /* Search & Filter Bar */
    .filter-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
      flex-wrap: wrap;
    }

    .search-box {
      position: relative;
      flex: 1;
      min-width: 260px;
    }

    .search-box svg {
      position: absolute;
      left: 10px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-tertiary);
      pointer-events: none;
    }

    .search-input {
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 7px 12px 7px 34px;
      font-size: 0.82rem;
      color: var(--text-primary);
      outline: none;
      transition: border-color 0.15s ease;
      font-family: inherit;
    }

    .search-input:focus {
      border-color: var(--border-muted);
    }

    .filter-pills {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .filter-btn {
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 500;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .filter-btn:hover {
      background: var(--bg-surface-elevated);
      color: var(--text-primary);
    }

    .filter-btn.active {
      background: var(--bg-surface-elevated);
      color: var(--text-primary);
      border-color: var(--border-muted);
    }

    /* Models Grid */
    .models-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 14px;
    }

    .model-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      transition: border-color 0.15s ease;
    }

    .model-card:hover {
      border-color: var(--border-muted);
    }

    .model-card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }

    .model-card-title {
      font-weight: 600;
      font-size: 0.92rem;
      color: var(--text-primary);
      line-height: 1.3;
    }

    .model-card-provider {
      font-size: 0.7rem;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      text-transform: uppercase;
      margin-top: 2px;
    }

    .model-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .badge-tag {
      font-size: 0.68rem;
      font-family: var(--font-mono);
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 500;
    }

    .badge-tag.emerald {
      background: var(--emerald-bg);
      color: var(--emerald-text);
      border: 1px solid var(--emerald-border);
    }

    .badge-tag.amber {
      background: var(--amber-bg);
      color: var(--amber-text);
      border: 1px solid var(--amber-border);
    }

    .badge-tag.coral {
      background: var(--coral-bg);
      color: var(--coral-text);
      border: 1px solid var(--coral-border);
    }

    .badge-tag.zinc {
      background: var(--zinc-bg);
      color: var(--zinc-text);
      border: 1px solid var(--zinc-border);
    }

    .badge-tag.cyan {
      background: var(--cyan-bg);
      color: var(--cyan-text);
      border: 1px solid var(--cyan-border);
    }

    .model-id-box {
      background: var(--bg-canvas);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 6px 10px;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      word-break: break-all;
    }

    .model-id-box .copy-btn {
      background: none;
      border: none;
      color: var(--text-tertiary);
      cursor: pointer;
      padding: 2px;
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    .model-id-box .copy-btn:hover {
      color: var(--text-primary);
    }

    .model-specs {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.75rem;
      color: var(--text-tertiary);
      border-top: 1px solid var(--border-subtle);
      padding-top: 10px;
    }

    .model-probe-status {
      font-size: 0.72rem;
      font-family: var(--font-mono);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Harness Grid */
    .harness-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 16px;
    }

    .harness-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .harness-card:hover {
      border-color: var(--border-muted);
    }

    .harness-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .harness-title-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .harness-icon {
      width: 32px;
      height: 32px;
      border-radius: 6px;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-secondary);
    }

    .harness-name {
      font-weight: 600;
      font-size: 0.95rem;
      color: var(--text-primary);
    }

    .harness-category {
      font-size: 0.72rem;
      color: var(--text-tertiary);
    }

    .harness-path-box {
      background: var(--bg-canvas);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 6px 10px;
      font-family: var(--font-mono);
      font-size: 0.72rem;
      color: var(--text-tertiary);
      overflow-x: auto;
      white-space: nowrap;
    }

    .harness-desc {
      font-size: 0.8rem;
      color: var(--text-secondary);
    }

    .harness-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: auto;
    }

    /* Code Snippet Box */
    .snippet-box {
      background: var(--bg-canvas);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 10px;
      position: relative;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--text-secondary);
      max-height: 180px;
      overflow-y: auto;
      margin-top: 8px;
      white-space: pre;
    }

    .snippet-box .snippet-copy {
      position: absolute;
      top: 6px;
      right: 6px;
      padding: 3px 6px;
      font-size: 0.7rem;
    }

    /* Table styles for accounts, combos, plugins */
    .table-container {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.82rem;
    }

    th {
      background: var(--bg-surface-elevated);
      color: var(--text-tertiary);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.7rem;
      letter-spacing: 0.04em;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }

    td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-subtle);
      color: var(--text-secondary);
    }

    tr:last-child td {
      border-bottom: none;
    }

    tr:hover td {
      background: var(--bg-surface-elevated);
      color: var(--text-primary);
    }

    /* Log Stream Terminal */
    .terminal {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 14px;
      font-family: var(--font-mono);
      font-size: 0.78rem;
      height: calc(100vh - 180px);
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .log-line {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 3px 6px;
      border-radius: 4px;
      transition: background 0.1s ease;
    }

    .log-line:hover {
      background: var(--bg-surface-elevated);
    }

    .log-time {
      color: var(--text-tertiary);
      flex-shrink: 0;
    }

    .log-method {
      font-weight: 600;
      color: var(--emerald-text);
      flex-shrink: 0;
    }

    .log-path {
      color: var(--text-primary);
      flex-shrink: 0;
    }

    .log-meta {
      color: var(--text-tertiary);
      margin-left: auto;
      display: flex;
      gap: 8px;
    }

    /* Modal Backdrop & Window */
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 100;
      padding: 20px;
    }

    .modal-backdrop.open,
    .modal-backdrop.active {
      display: flex;
    }

    .modal-window {
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 10px;
      width: 100%;
      max-width: 580px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .modal-title {
      font-weight: 600;
      font-size: 1rem;
      color: var(--text-primary);
    }

    .modal-close {
      background: none;
      border: none;
      color: var(--text-tertiary);
      cursor: pointer;
      display: flex;
      align-items: center;
      padding: 4px;
      border-radius: 4px;
    }

    .modal-close:hover {
      color: var(--text-primary);
      background: var(--bg-surface-elevated);
    }

    .modal-body {
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .modal-footer {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      padding: 14px 20px;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-surface-elevated);
    }

    /* Forms */
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .form-label {
      font-size: 0.78rem;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .form-input, .form-select, .form-textarea {
      background: var(--bg-canvas);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 0.82rem;
      color: var(--text-primary);
      outline: none;
      font-family: inherit;
      transition: border-color 0.15s ease;
    }

    .form-input:focus, .form-select:focus, .form-textarea:focus {
      border-color: var(--border-muted);
    }

    .form-hint {
      font-size: 0.7rem;
      color: var(--text-tertiary);
    }

    /* Provider Selector Tabs in Credentials Modal */
    .provider-tabs {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 6px;
    }

    .provider-tab-btn {
      background: var(--bg-canvas);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      padding: 8px 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: center;
    }

    .provider-tab-btn:hover {
      background: var(--bg-surface-elevated);
      border-color: var(--border-muted);
    }

    .provider-tab-btn.active {
      background: var(--bg-surface-elevated);
      border-color: var(--emerald);
      color: var(--text-primary);
    }

    .provider-tab-name {
      font-size: 0.72rem;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .provider-tab-btn.active .provider-tab-name {
      color: var(--text-primary);
    }

    /* Combo Wizard Indicator */
    .wizard-steps-indicator {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-subtle);
      padding-bottom: 14px;
    }

    .wizard-step-node {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.78rem;
      color: var(--text-tertiary);
    }

    .wizard-step-node.active {
      color: var(--text-primary);
      font-weight: 600;
    }

    .wizard-step-circle {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7rem;
      font-family: var(--font-mono);
    }

    .wizard-step-node.active .wizard-step-circle {
      border-color: var(--emerald);
      color: var(--emerald-text);
      background: var(--emerald-bg);
    }

    /* Toast Notifications */
    #toast-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 1000;
      pointer-events: none;
    }

    .toast {
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-muted);
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 0.8rem;
      color: var(--text-primary);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: auto;
      animation: toastIn 0.2s ease forwards;
      max-width: 380px;
    }

    .toast.success { border-color: var(--emerald-border); }
    .toast.error { border-color: var(--coral-border); }
    .toast.info { border-color: var(--zinc-border); }

    @keyframes toastIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Quota Tracker styles */
    .quota-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 16px;
      margin-top: 16px;
    }
    .quota-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      transition: border-color 0.15s ease;
    }
    .quota-card:hover {
      border-color: var(--border-muted);
    }
    .quota-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .quota-card-title {
      font-weight: 600;
      font-size: 0.95rem;
      color: var(--text-primary);
    }
    .quota-card-email {
      font-size: 0.75rem;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 220px;
    }
    .quota-item {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .quota-item-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.78rem;
    }
    .quota-item-name {
      color: var(--text-secondary);
      font-weight: 500;
    }
    .quota-item-meta {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--text-primary);
    }
    .quota-bar-track {
      width: 100%;
      height: 8px;
      background: #27272a;
      border-radius: 9999px;
      overflow: hidden;
      position: relative;
    }
    .quota-bar-fill {
      height: 100%;
      border-radius: 9999px;
      transition: width 0.3s ease;
    }
    .quota-bar-fill.threshold-healthy {
      background: #10b981;
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.3);
    }
    .quota-bar-fill.threshold-warning {
      background: #f59e0b;
      box-shadow: 0 0 8px rgba(245, 158, 11, 0.3);
    }
    .quota-bar-fill.threshold-critical {
      background: #f87171;
      box-shadow: 0 0 8px rgba(248, 113, 113, 0.3);
    }
    .quota-bar-fill.threshold-unlimited {
      background: #06b6d4;
      box-shadow: 0 0 8px rgba(6, 182, 212, 0.3);
    }
    .quota-reset-schedule {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 0.72rem;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
    }

    /* Usage View styles */
    .filter-pills {
      display: flex;
      align-items: center;
      gap: 4px;
      background: var(--bg-surface);
      padding: 4px;
      border-radius: 8px;
      border: 1px solid var(--border-subtle);
    }
    .filter-pill {
      padding: 4px 10px;
      font-size: 0.76rem;
      font-weight: 500;
      border-radius: 5px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .filter-pill:hover {
      color: var(--text-primary);
    }
    .filter-pill.active {
      background: var(--bg-surface-elevated);
      color: var(--text-primary);
      border-color: var(--border-muted);
    }
    .distribution-track {
      display: flex;
      height: 12px;
      width: 100%;
      border-radius: 6px;
      overflow: hidden;
      background: #27272a;
      margin-top: 8px;
      margin-bottom: 12px;
    }
    .distribution-segment {
      height: 100%;
      transition: width 0.3s ease;
    }
    .distribution-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 0.75rem;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--text-secondary);
    }
    .legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 2px;
    }
    .accordion-row {
      cursor: pointer;
      user-select: none;
    }
    .accordion-row:hover {
      background: var(--bg-surface-hover);
    }
    .accordion-nested-row {
      background: rgba(255, 255, 255, 0.015);
      font-size: 0.8rem;
    }
    .chevron-icon {
      transition: transform 0.2s ease;
      display: inline-block;
    }
    .chevron-icon.expanded {
      transform: rotate(90deg);
    }

    /* Real Token Usage Chart (Phase 7) */
    .token-chart-container {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: 14px;
    }
    .token-chart-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: var(--bg-surface-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 12px 16px;
    }
    .token-chart-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 0.8rem;
    }
    .token-chart-provider-name {
      font-weight: 600;
      color: var(--text-primary);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .token-chart-totals {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--text-secondary);
    }
    .token-stacked-bar {
      display: flex;
      height: 10px;
      width: 100%;
      border-radius: 9999px;
      overflow: hidden;
      background: #27272a;
    }
    .token-stacked-segment {
      height: 100%;
      transition: width 0.3s ease;
    }
    .token-chart-subbars {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 16px;
      font-size: 0.72rem;
      font-family: var(--font-mono);
      color: var(--text-tertiary);
    }
    .token-subbar-metric {
      display: flex;
      align-items: center;
      gap: 5px;
    }
  </style>
</head>
<body>
  <div id="toast-container"></div>

  <!-- Sidebar Navigation -->
  <aside>
    <div class="brand">
      <div class="brand-mark">${ICONS.layers}</div>
      <div>
        <div class="brand-title">Lattice Gateway</div>
        <div class="brand-subtitle">Mission Control v1.0</div>
      </div>
    </div>

    <nav id="sidebar-nav">
      <div class="nav-section-title">Core Systems</div>
      <a class="nav-item active" data-tab="overview" data-call-click="switchNavTab('overview')">
        ${ICONS.activity}
        <span>Overview &amp; KPIs</span>
      </a>
      <a class="nav-item" data-tab="plugins" data-call-click="switchNavTab('plugins')">
        ${ICONS.layers}
        <span>Provider Plugins</span>
        <span class="nav-badge emerald" id="badge-plugins-nav">--</span>
      </a>
      <a class="nav-item" data-tab="models" data-call-click="switchNavTab('models')">
        ${ICONS.cpu}
        <span>Free Models</span>
        <span class="nav-badge emerald" id="badge-models-count">--</span>
      </a>
      <a class="nav-item" data-tab="harnesses" data-call-click="switchNavTab('harnesses')">
        ${ICONS.terminal}
        <span>Harness Setup</span>
        <span class="nav-badge" id="badge-harness-count">--</span>
      </a>
      <a class="nav-item" data-tab="usage" data-call-click="switchNavTab('usage')">
        ${ICONS.barChart}
        <span>Usage</span>
      </a>
      <a class="nav-item" data-tab="quotas" data-call-click="switchNavTab('quotas')">
        ${ICONS.gauge}
        <span>Quota Tracker</span>
        <span class="nav-badge emerald" id="badge-quotas-health">Active</span>
      </a>
      <a class="nav-item" data-tab="telemetry" data-call-click="switchNavTab('telemetry')" style="display:none;">
        ${ICONS.activity}
        <span>Token Telemetry</span>
      </a>

      <div class="nav-section-title" style="margin-top: 6px;">Control Plane</div>
      <a class="nav-item" data-tab="accounts" data-call-click="switchNavTab('accounts')">
        ${ICONS.key}
        <span>Credential Pools</span>
        <span class="nav-badge" id="badge-accounts-count">--</span>
      </a>
      <a class="nav-item" data-tab="combos" data-call-click="switchNavTab('combos')">
        ${ICONS.gitBranch}
        <span>Virtual Combos</span>
        <span class="nav-badge" id="badge-combos-count">--</span>
      </a>
      <a class="nav-item" data-tab="logs" data-call-click="switchNavTab('logs')">
        ${ICONS.radio}
        <span>Live Ingress Stream</span>
        <span class="status-dot emerald pulse" style="margin-left:auto;"></span>
      </a>
    </nav>

    <div class="sidebar-footer">
      <button class="btn btn-primary" data-call-click="openCredentialsModal()">
        ${ICONS.plus}
        <span>Add Credentials</span>
      </button>
      <button class="btn btn-secondary" data-call-click="openComboWizard()">
        ${ICONS.sparkles}
        <span>Combo Wizard</span>
      </button>
      <button class="btn btn-emerald btn-sm" data-call-click="triggerSimulatedPing()">
        ${ICONS.play}
        <span>Simulate Telemetry</span>
      </button>
    </div>
  </aside>

  <!-- Main Workspace -->
  <main>
    <!-- =================================================================== -->
    <!-- VIEW 1: Overview & KPIs                                             -->
    <!-- =================================================================== -->
    <div class="tab-view active" id="view-overview">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Mission Control</h1>
          <p>Universal Multi-Provider LLM Gateway, Autonomous Credential Pool &amp; Virtual Combos</p>
        </div>
        <div class="header-actions">
          <div class="status-pill emerald">
            <span class="status-dot emerald pulse"></span>
            <span>Core Operational :4000</span>
          </div>
          <button class="btn btn-secondary btn-sm" data-call-click="switchNavTab('models')">
            ${ICONS.cpu}
            <span>Explore Free Models</span>
          </button>
          <button class="btn btn-primary btn-sm" data-call-click="switchNavTab('harnesses')">
            ${ICONS.terminal}
            <span>1-Click Harness Setup</span>
          </button>
        </div>
      </div>

      <!-- KPI Grid -->
      <div class="kpi-grid">
        <div class="kpi-card" data-call-click="switchNavTab('plugins')" style="cursor:pointer;" title="View Provider Plugins">
          <div class="kpi-label">Active Plugins</div>
          <div class="kpi-value" id="kpi-plugins" style="color: var(--text-primary);">--</div>
          <div class="kpi-subtext">Kilo Â· Nous Â· Cline Â· OpenCode Â· DeepSeek Â· Lattice</div>
        </div>
        <div class="kpi-card" data-call-click="switchNavTab('accounts')" style="cursor:pointer;" title="View Credential Pools">
          <div class="kpi-label">Active Accounts</div>
          <div class="kpi-value" id="kpi-accounts" style="color: var(--emerald-text);">--</div>
          <div class="kpi-subtext" id="kpi-accounts-sub">0 in rate cooldown</div>
        </div>
        <div class="kpi-card" data-call-click="switchNavTab('models')" style="cursor:pointer;" title="View Free Models">
          <div class="kpi-label">Free Models</div>
          <div class="kpi-value" id="kpi-models" style="color: var(--cyan-text);">-- Free</div>
          <div class="kpi-subtext" id="kpi-models-sub">-- with 1M context</div>
        </div>
        <div class="kpi-card" data-call-click="switchNavTab('combos')" style="cursor:pointer;" title="View Virtual Combos">
          <div class="kpi-label">Virtual Combos</div>
          <div class="kpi-value" id="kpi-combos" style="color: var(--text-primary);">--</div>
          <div class="kpi-subtext">Auto-failover active</div>
        </div>
        <div class="kpi-card" data-call-click="switchNavTab('telemetry')" style="cursor:pointer;" title="View Telemetry">
          <div class="kpi-label">Average Latency</div>
          <div class="kpi-value" id="kpi-latency" style="color: var(--amber-text);">~118ms</div>
          <div class="kpi-subtext">Rolling avg across upstreams</div>
        </div>
        <div class="kpi-card" data-call-click="switchNavTab('telemetry')" style="cursor:pointer;" title="View Telemetry">
          <div class="kpi-label">Streamed Tokens</div>
          <div class="kpi-value" id="kpi-tokens" style="color: var(--text-primary);">--</div>
          <div class="kpi-subtext" id="kpi-tokens-sub">524k in Â· 289k out</div>
        </div>
        <div class="kpi-card" data-call-click="switchNavTab('telemetry')" style="cursor:pointer;" title="View Telemetry">
          <div class="kpi-label">Cost Avoidance</div>
          <div class="kpi-value" id="kpi-saved" style="color: var(--emerald-text);">$21.45</div>
          <div class="kpi-subtext">$0 Free-tier value saved</div>
        </div>
      </div>

      <!-- Quick Action Hubs -->
      <div class="hub-grid">
        <div class="hub-card">
          <div class="hub-header">
            <div class="hub-icon">${ICONS.cpu}</div>
            <div>
              <div class="hub-title">Free Models Explorer</div>
              <div class="hub-desc" id="hub-models-desc">Zero-cost frontier models across active upstreams</div>
            </div>
          </div>
          <div class="hub-content" id="hub-models-content">
            Configure provider accounts to see their models here.
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-primary btn-sm" data-call-click="switchNavTab('models')">
              <span>Open Models Explorer</span>
              ${ICONS.arrowRight}
            </button>
          </div>
        </div>

        <div class="hub-card">
          <div class="hub-header">
            <div class="hub-icon">${ICONS.terminal}</div>
            <div>
              <div class="hub-title">Developer Harness Setup</div>
              <div class="hub-desc">1-click automated integration for local developer tools</div>
            </div>
          </div>
          <div class="hub-content">
            Automates configuration writing with timestamped backups for OpenCode, Kilo Code, Roo Code, Claude Code, Gemini CLI, Crush CLI, and Cursor.
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary btn-sm" data-call-click="switchNavTab('harnesses')">
              <span>Configure Harnesses</span>
              ${ICONS.arrowRight}
            </button>
          </div>
        </div>

        <div class="hub-card">
          <div class="hub-header">
            <div class="hub-icon">${ICONS.key}</div>
            <div>
              <div class="hub-title">Credential Pools</div>
              <div class="hub-desc">Multi-account token rotation &amp; cooldown management</div>
            </div>
          </div>
          <div class="hub-content">
            Autonomous health check probing, WorkOS OAuth device flow, and consentful account import from an explicit export path with a redacted preview.
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary btn-sm" data-call-click="switchNavTab('accounts')">Manage Accounts</button>
            <button class="btn btn-primary btn-sm" data-call-click="openCredentialsModal()">Add Key</button>
          </div>
        </div>

        <div class="hub-card">
          <div class="hub-header">
            <div class="hub-icon">${ICONS.gitBranch}</div>
            <div>
              <div class="hub-title">Virtual Combos</div>
              <div class="hub-desc">Composite models with zero-drop fallback cascades</div>
            </div>
          </div>
          <div class="hub-content">
            Compose multiple provider targets into a single virtual model endpoint with priority, round-robin, or lowest-latency routing.
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary btn-sm" data-call-click="switchNavTab('combos')">Configure Combos</button>
            <button class="btn btn-primary btn-sm" data-call-click="openComboWizard()">Combo Wizard</button>
          </div>
        </div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- VIEW 2: Free Models Explorer (R2)                                   -->
    <!-- =================================================================== -->
    <div class="tab-view" id="view-models">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Free Models Explorer</h1>
          <p>Searchable directory of models from your configured providers</p>
        </div>
        <div class="header-actions">
          <div class="status-pill emerald">
            <span class="status-dot emerald"></span>
            <span id="models-free-counter">No models available — add credentials via OAuth</span>
          </div>
        </div>
      </div>

      <!-- Filter and Search Bar -->
      <div class="filter-bar">
        <div class="search-box">
          ${ICONS.search}
          <input type="text" class="search-input" id="models-search" placeholder="Search models by name, ID, provider, capability, or tags..." data-call-input="filterModels()">
        </div>
        <div class="filter-pills">
          <button class="filter-btn active" data-filter="all" id="filter-models-all" data-call-click="setModelsFilter('all', this)">All</button>
          <button class="filter-btn" data-filter="1m" id="filter-models-1m" data-call-click="setModelsFilter('1m', this)">1M Context</button>
          <button class="filter-btn" data-filter="reasoning" data-call-click="setModelsFilter('reasoning', this)">Reasoning</button>
          <button class="filter-btn" data-filter="coding" data-call-click="setModelsFilter('coding', this)">Coding</button>
          <button class="filter-btn" data-filter="fast" data-call-click="setModelsFilter('fast', this)">Fast</button>
          <button class="filter-btn" data-filter="keyless" data-call-click="setModelsFilter('keyless', this)">Keyless Zen</button>
        </div>
        <select class="form-select" id="models-provider-filter" style="width: auto; padding: 5px 10px;" data-call-change="filterModels()">
          <option value="">All Providers</option>
          <option value="kilo">Kilo Code</option>
          <option value="cline">Cline Pool</option>
          <option value="deepseek">DeepSeek Web</option>
          <option value="opencode">OpenCode Zen</option>
          <option value="nous">Nous Research</option>
          <option value="lattice">Virtual Combos</option>
        </select>
      </div>

      <!-- Models Grid Container -->
      <div class="models-grid" id="models-grid-container">
        <!-- Rendered dynamically by JavaScript -->
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- VIEW 3: 1-Click Developer Harness Setup (R3)                        -->
    <!-- =================================================================== -->
    <div class="tab-view" id="view-harnesses">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Developer Harness Setup &amp; Configuration Automation</h1>
          <p>Automated 1-click configuration writing with timestamped backups for local CLI tools, extensions, and agents pointing to http://127.0.0.1:4000</p>
        </div>
        <div class="header-actions">
          <button class="btn btn-secondary btn-sm" data-call-click="refreshHarnessStatus()">
            ${ICONS.refresh}
            <span>Re-scan Status</span>
          </button>
          <button class="btn btn-primary btn-sm" data-call-click="setupAllHarnesses()">
            ${ICONS.check}
            <span>Configure All Detected</span>
          </button>
        </div>
      </div>

      <!-- Harness Status Grid -->
      <div class="harness-grid" id="harness-grid-container">
        <!-- Rendered dynamically by JavaScript -->
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- VIEW 4: Real-Time Telemetry                                         -->
    <!-- =================================================================== -->
    <div class="tab-view" id="view-telemetry">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Real-Time Token Telemetry &amp; Velocity</h1>
          <p>Live token ingress metrics, prompt/completion ratios, and upstream provider distribution</p>
        </div>
        <div class="header-actions">
          <button class="btn btn-emerald btn-sm" data-call-click="triggerSimulatedPing()">
            ${ICONS.play}
            <span>Simulate Telemetry Ping</span>
          </button>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Cumulative Tokens</div>
          <div class="kpi-value" id="telem-total" style="color: var(--text-primary);">--</div>
          <div class="kpi-subtext">Processed across all upstreams</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Prompt Tokens</div>
          <div class="kpi-value" id="telem-prompt" style="color: var(--cyan-text);">--</div>
          <div class="kpi-subtext">64.4% of total volume</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Completion Tokens</div>
          <div class="kpi-value" id="telem-completion" style="color: var(--emerald-text);">--</div>
          <div class="kpi-subtext">35.6% generated output</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total Ingress Requests</div>
          <div class="kpi-value" id="telem-requests" style="color: var(--text-primary);">--</div>
          <div class="kpi-subtext">Zero drops / 100% success</div>
        </div>
      </div>

      <div class="panel" style="margin-top: 14px;">
        <h3 style="font-size:0.95rem; font-weight:600; margin-bottom:12px;">Provider Token Allocation</h3>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Prompt Tokens</th>
                <th>Completion Tokens</th>
                <th>Total Streamed</th>
                <th>Estimated Cost Saved</th>
              </tr>
            </thead>
            <tbody id="telemetry-provider-tbody">
              <!-- Rendered dynamically -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- VIEW: Token Usage & Analytics (R3)                                   -->
    <!-- =================================================================== -->
    <div class="tab-view" id="view-usage">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Token Usage &amp; Analytics</h1>
          <p>Real-Time Token Telemetry, prompt/completion breakdown, cached savings, and cost analysis</p>
        </div>
        <div class="header-actions" style="display: flex; align-items: center; gap: 10px;">
          <div class="filter-pills" id="usage-period-pills">
            <button class="filter-pill active" data-call-click="setUsagePeriod('today')">Today</button>
            <button class="filter-pill" data-call-click="setUsagePeriod('24h')">24h</button>
            <button class="filter-pill" data-call-click="setUsagePeriod('7d')">7D</button>
            <button class="filter-pill" data-call-click="setUsagePeriod('30d')">30D</button>
            <button class="filter-pill" data-call-click="setUsagePeriod('all')">All</button>
          </div>
          <div class="filter-pills" id="usage-mode-pills">
            <button class="filter-pill active" id="btn-mode-tokens" data-call-click="toggleUsageMode('tokens')">Tokens</button>
            <button class="filter-pill" id="btn-mode-cost" data-call-click="toggleUsageMode('cost')">Cost ($)</button>
          </div>
          <button class="btn btn-secondary btn-sm" data-call-click="fetchUsageStats()">
            ${ICONS.refresh}
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <!-- 5 KPI Cards -->
      <div class="kpi-grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
        <div class="kpi-card">
          <div class="kpi-label">Total Requests</div>
          <div class="kpi-value" id="usage-kpi-requests" style="color: var(--text-primary);">--</div>
          <div class="kpi-subtext">100% Ingress Success Rate</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total Input Tokens</div>
          <div class="kpi-value" id="usage-kpi-prompt" style="color: var(--cyan-text);">--</div>
          <div class="kpi-subtext">64.4% Ingress Volume</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Cached Tokens</div>
          <div class="kpi-value" id="usage-kpi-cached" style="color: #60a5fa;">--</div>
          <div class="kpi-subtext">24.5% Cached Reads</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Output Tokens</div>
          <div class="kpi-value" id="usage-kpi-completion" style="color: var(--emerald-text);">--</div>
          <div class="kpi-subtext">35.6% Generated Output</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Est. Cost Saved</div>
          <div class="kpi-value" id="usage-kpi-cost" style="color: var(--amber-text);">--</div>
          <div class="kpi-subtext">vs Commercial API billing</div>
        </div>
      </div>

      <!-- Provider Ingress Distribution Visual Track -->
      <div class="panel" style="margin-top: 16px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3 style="font-size:0.95rem; font-weight:600;">Provider Ingress Distribution</h3>
          <span style="font-size:0.75rem; color:var(--text-tertiary); font-family:var(--font-mono);" id="usage-dist-summary">Total: -- tokens</span>
        </div>
        <div class="distribution-track" id="usage-distribution-track">
          <div class="distribution-segment" style="width: 36%; background: #10b981;" title="Kilo Code: 36%"></div>
          <div class="distribution-segment" style="width: 25%; background: #f59e0b;" title="Nous Research: 25%"></div>
          <div class="distribution-segment" style="width: 20%; background: #06b6d4;" title="Cline Free Pool: 20%"></div>
          <div class="distribution-segment" style="width: 12%; background: #a855f7;" title="OpenCode Zen: 12%"></div>
          <div class="distribution-segment" style="width: 7%; background: #3b82f6;" title="DeepSeek Web: 7%"></div>
        </div>
        <div class="distribution-legend" id="usage-distribution-legend">
          <div class="legend-item"><span class="legend-dot" style="background: #10b981;"></span><span>Kilo Code: <strong>36.0%</strong></span></div>
          <div class="legend-item"><span class="legend-dot" style="background: #f59e0b;"></span><span>Nous Research: <strong>25.0%</strong></span></div>
          <div class="legend-item"><span class="legend-dot" style="background: #06b6d4;"></span><span>Cline Free Pool: <strong>20.0%</strong></span></div>
          <div class="legend-item"><span class="legend-dot" style="background: #a855f7;"></span><span>OpenCode Zen: <strong>12.0%</strong></span></div>
          <div class="legend-item"><span class="legend-dot" style="background: #3b82f6;"></span><span>DeepSeek Web: <strong>7.0%</strong></span></div>
        </div>
      </div>

      <!-- Real Token Usage Chart (Phase 7 Real Edge Accounting) -->
      <div class="panel" style="margin-top: 16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
          <div>
            <h3 style="font-size:0.95rem; font-weight:600; display:flex; align-items:center; gap:8px;">
              <span>Real Token Usage &amp; Volume Accounting</span>
              <span class="badge-tag emerald" style="font-size:0.65rem;">gpt-tokenizer BPE</span>
            </h3>
            <p style="font-size:0.75rem; color:var(--text-tertiary);">Live input (prompt), cached, and output (completion) tokens measured at the gateway edge</p>
          </div>
          <div style="display:flex; align-items:center; gap:14px; font-size:0.75rem; font-family:var(--font-mono);">
            <div style="display:flex; align-items:center; gap:5px;"><span class="legend-dot" style="background:var(--cyan-text);"></span><span>Prompt (Input)</span></div>
            <div style="display:flex; align-items:center; gap:5px;"><span class="legend-dot" style="background:#60a5fa;"></span><span>Cached</span></div>
            <div style="display:flex; align-items:center; gap:5px;"><span class="legend-dot" style="background:var(--emerald-text);"></span><span>Completion (Output)</span></div>
          </div>
        </div>
        <div class="token-chart-container" id="usage-chart-container">
          <!-- Rendered dynamically by JavaScript -->
        </div>
      </div>

      <!-- Accordion Model Breakdown Table -->
      <div class="panel" style="margin-top: 16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;">
          <div>
            <h3 style="font-size:0.95rem; font-weight:600;">Model &amp; Provider Breakdown</h3>
            <p style="font-size:0.75rem; color:var(--text-tertiary);">Click any provider row to toggle individual model metrics</p>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <select class="input-field" id="usage-provider-filter" data-call-change="renderUsageView()" style="width:160px; padding:4px 8px; font-size:0.75rem;">
              <option value="all">All Providers</option>
              <option value="kilo">Kilo Code</option>
              <option value="nous">Nous Research</option>
              <option value="cline">Cline Free Pool</option>
              <option value="opencode">OpenCode Zen</option>
              <option value="deepseek">DeepSeek Web</option>
            </select>
          </div>
        </div>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th style="width: 32%;">Provider / Model</th>
                <th style="text-align: right;">Input Tokens</th>
                <th style="text-align: right;">Cached Tokens</th>
                <th style="text-align: right;">Output Tokens</th>
                <th style="text-align: right;" id="col-metric-total">Total Tokens</th>
                <th style="text-align: right;">Cost Saved ($)</th>
                <th style="text-align: right;">Requests</th>
              </tr>
            </thead>
            <tbody id="usage-breakdown-tbody">
              <!-- Rendered dynamically -->
            </tbody>
          </table>
        </div>
      </div>

      <!-- Recent Ingress Request Log -->
      <div class="panel" style="margin-top: 16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;">
          <div>
            <h3 style="font-size:0.95rem; font-weight:600;">Recent Ingress Request Log</h3>
            <p style="font-size:0.75rem; color:var(--text-tertiary);">Live telemetry of real-world requests processed through the gateway</p>
          </div>
          <button class="btn btn-secondary btn-sm" data-call-click="fetchUsageStats()">
            ${ICONS.refresh}
            <span>Refresh Log</span>
          </button>
        </div>
        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Method / Path</th>
                <th>Provider</th>
                <th>Model</th>
                <th style="text-align: right;">Input</th>
                <th style="text-align: right;">Output</th>
                <th style="text-align: right;">Latency</th>
                <th>Status</th>
                <th style="text-align: center;">Inspection</th>
              </tr>
            </thead>
            <tbody id="usage-logs-tbody">
              <!-- Rendered dynamically -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Request Inspection Modal -->
    <div class="modal-backdrop" id="modal-request-detail" data-call-click="closeRequestDetailModal(event)">
      <div class="modal" style="max-width: 680px;" data-call-click="event.stopPropagation()">
        <div class="modal-header">
          <div>
            <div class="modal-title">Request Inspection Details</div>
            <div class="modal-subtitle" id="req-modal-subtitle">Telemetry drilldown and payload tracing</div>
          </div>
          <button class="modal-close" data-call-click="closeRequestDetailModal()">${ICONS.x}</button>
        </div>
        <div class="modal-body" style="display:flex; flex-direction:column; gap:12px;">
          <div>
            <label style="font-size:0.75rem; font-weight:600; color:var(--text-secondary); text-transform:uppercase;">Overview</label>
            <div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:6px; padding:10px; font-family:var(--font-mono); font-size:0.78rem; display:grid; grid-template-columns:1fr 1fr; gap:6px;" id="req-modal-overview">
              <!-- Rendered dynamically -->
            </div>
          </div>
          <div>
            <label style="font-size:0.75rem; font-weight:600; color:var(--text-secondary); text-transform:uppercase;">Client Request Payload</label>
            <pre style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:6px; padding:10px; font-family:var(--font-mono); font-size:0.75rem; max-height:160px; overflow-y:auto; color:#a1a1aa;" id="req-modal-payload"></pre>
          </div>
          <div>
            <label style="font-size:0.75rem; font-weight:600; color:var(--text-secondary); text-transform:uppercase;">Response Summary / Reasoning Trace</label>
            <pre style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:6px; padding:10px; font-family:var(--font-mono); font-size:0.75rem; max-height:160px; overflow-y:auto; color:var(--emerald-text);" id="req-modal-response"></pre>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" data-call-click="closeRequestDetailModal()">Close</button>
        </div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- VIEW: Quota Tracker (R4)                                            -->
    <!-- =================================================================== -->
    <div class="tab-view" id="view-quotas">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Provider &amp; Account Quota Tracker</h1>
          <p>Real-time rate limits, session quotas, sliding windows, and account health</p>
        </div>
        <div class="header-actions" style="display:flex; align-items:center; gap:8px;">
          <div class="filter-pills" id="quota-filter-pills">
            <button class="filter-pill active" data-call-click="filterQuotas('all')">All Accounts</button>
            <button class="filter-pill" data-call-click="filterQuotas('active')">Active</button>
            <button class="filter-pill" data-call-click="filterQuotas('cooldown')">In Cooldown</button>
          </div>
          <button class="btn btn-secondary btn-sm" data-call-click="fetchQuotas()">
            ${ICONS.refresh}
            <span>Refresh Quotas</span>
          </button>
        </div>
      </div>

      <!-- 4 Quota Summary Cards -->
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Accounts</div>
          <div class="kpi-value" id="quota-sum-total" style="color: var(--text-primary);">--</div>
          <div class="kpi-subtext">Across 5 active providers</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Active Pools</div>
          <div class="kpi-value" id="quota-sum-active" style="color: var(--emerald-text);">--</div>
          <div class="kpi-subtext">Available for immediate routing</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Healthy Quotas</div>
          <div class="kpi-value" id="quota-sum-healthy" style="color: var(--cyan-text);">--</div>
          <div class="kpi-subtext">&gt; 70% remaining quota capacity</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">In Cooldown / Depleted</div>
          <div class="kpi-value" id="quota-sum-cooldown" style="color: var(--amber-text);">--</div>
          <div class="kpi-subtext">Auto-failover active</div>
        </div>
      </div>

      <!-- Provider Quota Overview Panel (R4 additions) -->
      <div class="panel" style="margin-top: 16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px;">
          <div>
            <h3 style="font-size:0.95rem; font-weight:600;">Provider Quota Capacity &amp; Windows</h3>
            <p style="font-size:0.75rem; color:var(--text-tertiary);">Aggregated capacity, remaining quota, real tokens consumed, and reset schedule per upstream provider</p>
          </div>
          <span class="badge-tag emerald" id="badge-provider-quota-status">Providers Monitored</span>
        </div>
        <div class="quota-grid" id="provider-quota-cards-container">
          <!-- Rendered dynamically by JavaScript -->
        </div>
      </div>

      <div style="margin-top: 24px; margin-bottom: 10px;">
        <h3 style="font-size:0.95rem; font-weight:600;">Individual Account Quota Pools</h3>
        <p style="font-size:0.75rem; color:var(--text-tertiary);">Per-account rate limits, session quotas, sliding windows, and account health</p>
      </div>

      <!-- Quota Cards Grid -->
      <div class="quota-grid" id="quota-cards-container">
        <!-- Rendered dynamically by JavaScript -->
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- VIEW 5: Credential Pools                                            -->
    <!-- =================================================================== -->
    <div class="tab-view" id="view-accounts">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Credential Pools &amp; Upstream Accounts</h1>
          <p>Multi-account token pools with auto-rotation, rate-limit cooldown, and live health probing</p>
        </div>
        <div class="header-actions">
          <button class="btn btn-secondary btn-sm" data-call-click="syncLocalAccounts()">
            ${ICONS.refresh}
            <span>Import Accounts (Explicit Export)</span>
          </button>
          <button class="btn btn-primary btn-sm" data-call-click="openCredentialsModal()">
            ${ICONS.plus}
            <span>Add Account</span>
          </button>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Account ID</th>
              <th>Provider</th>
              <th>Auth Type</th>
              <th>Status</th>
              <th>Errors</th>
              <th>Credentials Preview</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="accounts-table-body">
            <!-- Rendered dynamically -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- VIEW 6: Virtual Combos                                              -->
    <!-- =================================================================== -->
    <div class="tab-view" id="view-combos">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Virtual Model Combos &amp; Failover Cascades</h1>
          <p>Composite models providing automatic multi-provider failover without dropping client requests</p>
        </div>
        <div class="header-actions">
          <button class="btn btn-primary btn-sm" data-call-click="openComboWizard()">
            ${ICONS.plus}
            <span>Create Virtual Combo</span>
          </button>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th style="width: 20%;">Combo ID</th>
              <th style="width: 18%;">Name</th>
              <th style="width: 14%;">Health</th>
              <th style="width: 38%;">Target Cascade Chain (Reachability)</th>
              <th style="width: 10%;">Actions</th>
            </tr>
          </thead>
          <tbody id="combos-table-body">
            <!-- Rendered dynamically -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- VIEW: Provider Plugins & Upstreams                                  -->
    <!-- =================================================================== -->
    <div class="tab-view" id="view-plugins">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Provider Plugins &amp; Upstreams</h1>
          <p>Upstream protocol adapters managing live endpoint dispatch, token authentication, and credential routing</p>
        </div>
        <div class="header-actions">
          <button class="btn btn-secondary btn-sm" data-call-click="syncLocalAccounts()">
            ${ICONS.refresh}
            <span>Import Accounts (Explicit Export)</span>
          </button>
          <button class="btn btn-primary btn-sm" data-call-click="openCredentialsModal()">
            ${ICONS.plus}
            <span>Add Credentials</span>
          </button>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Plugins</div>
          <div class="kpi-value" id="plugins-kpi-total">--</div>
          <div class="kpi-subtext">Registered upstream adapters</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Active Adapters</div>
          <div class="kpi-value" id="plugins-kpi-active" style="color:var(--emerald-text);">--</div>
          <div class="kpi-subtext">Routing requests live</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Connected Accounts</div>
          <div class="kpi-value" id="plugins-kpi-accounts">8</div>
          <div class="kpi-subtext">Across active credential pools</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Available Models</div>
          <div class="kpi-value" id="plugins-kpi-models">--</div>
          <div class="kpi-subtext">Zero-cost inference endpoints</div>
        </div>
      </div>

      <div class="panel">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
          <div>
            <div style="font-weight:600; font-size:1rem; color:var(--text-primary);">Registered Upstream Adapters</div>
            <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:2px;">Core protocol implementations and connection status</div>
          </div>
          <div class="status-pill emerald">
            <span class="status-dot emerald"></span>
            <span>All Core Upstreams Ready</span>
          </div>
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th style="width: 24%;">Adapter / Plugin</th>
                <th style="width: 28%;">Endpoint Base URL</th>
                <th style="width: 18%;">Auth Strategy</th>
                <th style="width: 14%;">Credential Pool</th>
                <th style="width: 8%;">State</th>
                <th style="width: 8%;">Action</th>
              </tr>
            </thead>
            <tbody id="plugins-table-body">
              <!-- Rendered dynamically -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- VIEW 8: Live Ingress Stream                                         -->
    <!-- =================================================================== -->
    <div class="tab-view" id="view-logs">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Live Ingress SSE Stream</h1>
          <p>Real-time wire events captured on port 4000 across OpenAI and Anthropic endpoints</p>
        </div>
        <div class="header-actions">
          <button class="btn btn-secondary btn-sm" data-call-click="clearLogs()">
            ${ICONS.trash}
            <span>Clear Buffer</span>
          </button>
        </div>
      </div>

      <div class="terminal" id="terminal-logs">
        <!-- Live SSE stream logs appended here -->
      </div>
    </div>
  </main>

  <!-- ===================================================================== -->
  <!-- MODAL 1: Add Credentials Modal (Preserving test invariants)           -->
  <!-- ===================================================================== -->
  <div class="modal-backdrop" id="modal-credentials" data-call-click="onBackdropClick(event, 'modal-credentials')">
    <div class="modal-window">
      <div class="modal-header">
        <div class="modal-title">Register Upstream Provider Credentials</div>
        <button class="modal-close" data-call-click="closeCredentialsModal()">${ICONS.x}</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Select Upstream Provider</label>
          <div class="provider-tabs">
            <div class="provider-tab-btn active" id="tab-btn-cline" data-call-click="switchProviderTab('cline')">
              <span class="provider-tab-name">Cline Pool</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-kilo" data-call-click="switchProviderTab('kilo')">
              <span class="provider-tab-name">Kilo Code</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-nous" data-call-click="switchProviderTab('nous')">
              <span class="provider-tab-name">Nous Research</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-deepseek" data-call-click="switchProviderTab('deepseek')">
              <span class="provider-tab-name">DeepSeek</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-opencode" data-call-click="switchProviderTab('opencode')">
              <span class="provider-tab-name">OpenCode Zen</span>
            </div>
          </div>
        </div>

        <div id="provider-fields-container"></div>
      </div>
      <div class="modal-footer" id="modal-credentials-footer">
        <button class="btn btn-secondary" data-call-click="closeCredentialsModal()">Cancel</button>
        <button class="btn btn-primary" id="btn-save-account" data-call-click="submitAccountForm()">Save &amp; Connect Account</button>
      </div>
    </div>
  </div>

  <!-- ===================================================================== -->
  <!-- MODAL 2: Virtual Combo Creator Wizard (Preserving test invariants)    -->
  <!-- ===================================================================== -->
  <div class="modal-backdrop" id="modal-combo-wizard" data-call-click="onBackdropClick(event, 'modal-combo-wizard')">
    <div class="modal-window" style="max-width:760px;">
      <div class="modal-header">
        <div>
          <div class="modal-title">Virtual Model Combo Creator Wizard</div>
          <p style="font-size:0.75rem; color:var(--text-tertiary); margin-top:2px;">
            Configure zero-drop cascade failover across multiple providers
          </p>
        </div>
        <button class="modal-close" data-call-click="closeComboWizard()">${ICONS.x}</button>
      </div>

      <div class="modal-body">
        <div class="wizard-steps-indicator">
          <div class="wizard-step-node active" id="wizard-node-1">
            <div class="wizard-step-circle">1</div>
            <span>Identity</span>
          </div>
          <div class="wizard-step-node" id="wizard-node-2">
            <div class="wizard-step-circle">--</div>
            <span>Fallback Chain</span>
          </div>
          <div class="wizard-step-node" id="wizard-node-3">
            <div class="wizard-step-circle">3</div>
            <span>Policies</span>
          </div>
          <div class="wizard-step-node" id="wizard-node-4">
            <div class="wizard-step-circle">4</div>
            <span>Deploy</span>
          </div>
        </div>

        <!-- Step 1: Identity -->
        <div id="wizard-page-1">
          <div class="form-group">
            <label class="form-label">Virtual Combo ID (Model Identifier)</label>
            <input type="text" class="form-input" id="wizard-combo-id" placeholder="e.g. lattice/code-flagship" required>
            <span class="form-hint">Clients will request this exact model string in their OpenAI / Anthropic requests.</span>
          </div>
          <div class="form-group" style="margin-top:10px;">
            <label class="form-label">Display Name</label>
            <input type="text" class="form-input" id="wizard-combo-name" placeholder="e.g. Flagship Coding Cascade (Kilo -> DeepSeek)">
          </div>
          <div class="form-group" style="margin-top:10px;">
            <label class="form-label">Description / Purpose</label>
            <input type="text" class="form-input" id="wizard-combo-desc" placeholder="e.g. Primary coding combo with automated free-tier failover">
          </div>
          <div class="form-group" style="margin-top:10px;">
            <label class="form-label">Cascade Routing Strategy</label>
            <select class="form-select" id="wizard-combo-strategy">
              <option value="priority">Priority Cascade (Try targets strictly in order 1 -> 2 -> 3)</option>
              <option value="round-robin">Round Robin (Distribute requests evenly across healthy targets)</option>
              <option value="lowest-latency">Lowest Latency (Prefer fastest responding upstream)</option>
            </select>
          </div>
        </div>

        <!-- Step 2: Fallback Chain -->
        <div id="wizard-page-2" style="display:none;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <label class="form-label" style="margin:0;">Configured Fallback Target Chain (<span id="wizard-chain-count">0</span> models)</label>
            <span style="font-size:0.75rem; color:var(--text-tertiary);">Priority Order: 1 &rarr; 2 &rarr; 3</span>
          </div>
          
          <!-- Selected targets list -->
          <div id="wizard-targets-list" style="display:flex; flex-direction:column; gap:6px; margin-top:8px; max-height:160px; overflow-y:auto; padding-right:4px;"></div>

          <!-- Chain Preview visual (preserving id for tests) -->
          <div style="margin-top:10px; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:6px; padding:8px 12px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:0.7rem; color:var(--text-tertiary); font-family:var(--font-mono); text-transform:uppercase;">Live Cascade Pipeline</span>
            </div>
            <div id="wizard-chain-preview" style="font-family:var(--font-mono); font-size:0.78rem; color:var(--cyan-text); margin-top:4px; word-break:break-all;"></div>
          </div>

          <!-- Interactive Model Directory Browser -->
          <div style="margin-top:14px; border-top:1px solid var(--border-subtle); padding-top:12px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <label class="form-label" style="margin:0;">Select Models from Live Catalog</label>
              <span style="font-size:0.72rem; color:var(--text-tertiary);" id="wizard-models-count-label"></span>
            </div>

            <!-- Search Bar -->
            <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
              <div style="position:relative; flex:1;">
                <input type="text" class="form-input" id="wizard-model-search" placeholder="Search models by name, id, provider, tags (e.g. nemotron, sonnet, 1m)..." data-call-input="filterWizardModels()" style="padding-left:28px;">
                <span style="position:absolute; left:9px; top:50%; transform:translateY(-50%); color:var(--text-tertiary); font-size:0.8rem; pointer-events:none;">&#128269;</span>
              </div>
              <button class="btn btn-secondary btn-sm" data-call-click="clearWizardModelSearch()" title="Clear search">Clear</button>
            </div>

            <!-- Category / Provider Filter Chips -->
            <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:10px;" id="wizard-model-chips">
              <button class="filter-pill active" data-call-click="setWizardModelFilter('all', this)">All</button>
              <button class="filter-pill" data-call-click="setWizardModelFilter('free', this)">&#127379; Free Tier (:free)</button>
              <button class="filter-pill" data-call-click="setWizardModelFilter('1m', this)">&#9889; 1M Context</button>
              <button class="filter-pill" data-call-click="setWizardModelFilter('coding', this)">&#128187; Coding</button>
              <button class="filter-pill" data-call-click="setWizardModelFilter('kilo', this)">Kilo</button>
              <button class="filter-pill" data-call-click="setWizardModelFilter('cline', this)">Cline</button>
              <button class="filter-pill" data-call-click="setWizardModelFilter('nous', this)">Nous</button>
              <button class="filter-pill" data-call-click="setWizardModelFilter('deepseek', this)">DeepSeek</button>
            </div>

            <!-- Scrollable Model Catalog -->
            <div id="wizard-model-directory" style="max-height:190px; overflow-y:auto; display:flex; flex-direction:column; gap:6px; padding-right:4px;">
              <!-- Rendered dynamically -->
            </div>

            <!-- Custom Manual Target Input -->
            <div style="margin-top:10px; display:flex; gap:8px; align-items:center;">
              <input type="text" class="form-input" id="wizard-custom-target" placeholder="Or enter custom target: provider/model-id" style="flex:1; font-size:0.8rem;">
              <button class="btn btn-secondary btn-sm" data-call-click="addCustomTarget()">+ Add Custom</button>
            </div>
          </div>
        </div>

        <!-- Step 3: Policies -->
        <div id="wizard-page-3" style="display:none;">
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
            <div class="form-group">
              <label class="form-label">Per-Target Timeout (ms)</label>
              <input type="number" class="form-input" id="wizard-timeout" value="45000">
              <span class="form-hint">Time before failover to next target.</span>
            </div>
            <div class="form-group">
              <label class="form-label">Max Failover Retries</label>
              <input type="number" class="form-input" id="wizard-retries" value="3">
              <span class="form-hint">Number of sequential cascades attempted.</span>
            </div>
          </div>

          <div class="form-group" style="margin-top:10px;">
            <label class="form-label">Failure Trigger Status Codes</label>
            <input type="text" class="form-input" id="wizard-fail-statuses" value="429, 500, 502, 503, 504">
            <span class="form-hint">Comma separated list of upstream HTTP statuses that initiate failover.</span>
          </div>

          <div class="form-group" style="margin-top:10px;">
            <label class="form-label">Proxy &amp; Network Routing</label>
            <div style="display:flex; align-items:center; gap:8px; margin-top:4px;">
              <input type="checkbox" id="wizard-use-proxies" checked style="width:16px; height:16px; accent-color:var(--emerald);">
              <label for="wizard-use-proxies" style="font-size:0.8rem; color:var(--text-secondary); cursor:pointer;">
                Rotate through residential/datacenter proxy pool on 429/403
              </label>
            </div>
          </div>
        </div>

        <!-- Step 4: Deploy -->
        <div id="wizard-page-4" style="display:none;">
          <div style="background:var(--emerald-bg); border:1px solid var(--emerald-border); border-radius:6px; padding:12px;">
            <div style="font-weight:600; color:var(--emerald-text); font-size:0.85rem;">Configuration Validated</div>
            <p style="font-size:0.78rem; color:var(--text-secondary); margin-top:2px;">
              Ready to write to storage and register live across gateway routers.
            </p>
          </div>

          <div style="margin-top:12px;">
            <label class="form-label">Combo Blueprint JSON</label>
            <textarea class="form-textarea" id="wizard-summary-json" readonly style="height:120px; font-family:var(--font-mono); font-size:0.75rem;"></textarea>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" id="wizard-btn-prev" data-call-click="prevWizardStep()" style="display:none;">Back</button>
        <button class="btn btn-primary" id="wizard-btn-next" data-call-click="nextWizardStep()">Next: Fallback Chain</button>
      </div>
    </div>
  </div>

  <!-- Client-Side Vanilla SPA Script Engine -->
  <script${nonceAttr}>
    // ADMIN_TOKEN_BOOTSTRAP_START
    (function () {
      var key = 'lattice-admin-token';
      var token = sessionStorage.getItem(key);
      if (!token) {
        token = window.prompt('Lattice admin token (printed when the gateway started)') || '';
        if (token) sessionStorage.setItem(key, token);
      }
      var originalFetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        init = init || {};
        var headers = new Headers(init.headers || (input && input.headers) || {});
        if (token && !headers.has('Authorization')) {
          headers.set('Authorization', 'Bearer ' + token);
        }
        var next = {};
        for (var k in init) {
          if (Object.prototype.hasOwnProperty.call(init, k)) next[k] = init[k];
        }
        next.headers = headers;
        return originalFetch(input, next);
      };
    })();
    // ADMIN_TOKEN_BOOTSTRAP_END
    // CSP bridges. The document is served with a nonce-only policy, so:
    //  - inline style attributes are promoted into a nonce-bearing stylesheet;
    //  - former inline handlers are dispatched through an allow-list below.
    (function () {
      const styleTag = document.createElement('style');
      const scriptNonce = document.currentScript && document.currentScript.getAttribute('nonce');
      if (scriptNonce) styleTag.setAttribute('nonce', scriptNonce);
      styleTag.setAttribute('data-inline-style-bridge', '');
      document.head.appendChild(styleTag);
      const rules = [];
      let seq = 0;
      function absorbStyles(root) {
        if (!root || root.nodeType !== 1) return;
        if (root.hasAttribute('style')) {
          const css = root.getAttribute('style');
          const cls = 'lnl-inline-' + (seq++);
          root.classList.add(cls);
          rules.push('.' + cls + '{' + css + '}');
          root.removeAttribute('style');
          styleTag.textContent = rules.join('\\n');
        }
        if (root.querySelectorAll) root.querySelectorAll('[style]').forEach(absorbStyles);
      }
      absorbStyles(document.documentElement);
      new MutationObserver(function (records) {
        for (const rec of records) {
          if (rec.type === 'childList') {
            for (const node of rec.addedNodes) absorbStyles(node);
          } else if (rec.attributeName === 'style') {
            absorbStyles(rec.target);
          }
        }
      }).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['style']
      });
    })();

    // Last-resort boundary: every innerHTML assignment is cleaned of executable
    // markup, so a missed interpolation cannot become active content even
    // though the strict CSP would already block it.
    function sanitizeDashboardHtml(html) {
      const template = document.createElement('template');
      nativeInnerHTML.set.call(template, String(html));
      for (const node of template.content.querySelectorAll('*')) {
        const tag = String(node.tagName || '').toUpperCase();
        if (tag === 'SCRIPT' || tag === 'IFRAME' || tag === 'OBJECT' ||
            tag === 'EMBED' || tag === 'BASE' || tag === 'META' || tag === 'LINK') {
          if (node.remove) node.remove();
          continue;
        }
        for (const attr of Array.from(node.attributes || [])) {
          const name = String(attr.name).toLowerCase();
          const value = String(attr.value).trim().toLowerCase();
          if (name.startsWith('on') || name === 'srcdoc' ||
              ((name === 'href' || name === 'src' || name === 'xlink:href') && value.startsWith('javascript:'))) {
            node.removeAttribute(attr.name);
          }
        }
      }
      return nativeInnerHTML.get.call(template);
    }
    const nativeInnerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (nativeInnerHTML && nativeInnerHTML.set && nativeInnerHTML.get) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true,
        get: function () { return nativeInnerHTML.get.call(this); },
        set: function (value) { nativeInnerHTML.set.call(this, sanitizeDashboardHtml(value)); }
      });
    }

    const CALLABLES = {
      addCustomTarget: addCustomTarget,
      clearLogs: clearLogs,
      clearWizardModelSearch: clearWizardModelSearch,
      closeComboWizard: closeComboWizard,
      closeCredentialsModal: closeCredentialsModal,
      closeRequestDetailModal: closeRequestDetailModal,
      connectOpenCodeKeyless: connectOpenCodeKeyless,
      fetchQuotas: fetchQuotas,
      fetchUsageStats: fetchUsageStats,
      filterModels: filterModels,
      filterQuotas: filterQuotas,
      filterWizardModels: filterWizardModels,
      moveWizardTarget: moveWizardTarget,
      nextWizardStep: nextWizardStep,
      onBackdropClick: onBackdropClick,
      openComboWizard: openComboWizard,
      openCredentialsModal: openCredentialsModal,
      prevWizardStep: prevWizardStep,
      refreshHarnessStatus: refreshHarnessStatus,
      removeWizardTarget: removeWizardTarget,
      renderUsageView: renderUsageView,
      setModelsFilter: setModelsFilter,
      setUsagePeriod: setUsagePeriod,
      setWizardModelFilter: setWizardModelFilter,
      setupAllHarnesses: setupAllHarnesses,
      showRequestDetailModal: showRequestDetailModal,
      submitAccountForm: submitAccountForm,
      switchNavTab: switchNavTab,
      switchProviderTab: switchProviderTab,
      syncLocalAccounts: syncLocalAccounts,
      toggleTargetInChain: toggleTargetInChain,
      toggleUsageMode: toggleUsageMode,
      triggerSimulatedPing: triggerSimulatedPing
    };

    function invokeCall(expr, el, event) {
      if (!expr) return;
      if (expr === 'event.stopPropagation()') { event.stopPropagation(); return; }
      const match = /^([A-Za-z_$][\\w$]*)\\((.*)\\)$/.exec(expr.trim());
      if (!match || !CALLABLES[match[1]]) return;
      const body = match[2].trim();
      const args = body ? body.split(',').map(function (part) {
        const a = part.trim();
        if (a === 'event') return event;
        if (a === 'this') return el;
        if (a === 'this.dataset.target') return el.dataset.target;
        if (a === 'this.dataset.id') return el.dataset.id;
        if (/^-?\\d+$/.test(a)) return Number(a);
        if (a.length > 1 && ((a[0] === "'" && a[a.length - 1] === "'") || (a[0] === '"' && a[a.length - 1] === '"'))) {
          return a.slice(1, -1);
        }
        return a;
      }) : [];
      CALLABLES[match[1]].apply(null, args);
    }

    for (const callEvent of ['click', 'input', 'change', 'keydown', 'keyup', 'focus', 'blur', 'submit']) {
      document.addEventListener(callEvent, function (event) {
        const target = event.target && event.target.closest
          ? event.target.closest('[data-call-' + callEvent + ']')
          : null;
        if (target) invokeCall(target.getAttribute('data-call-' + callEvent), target, event);
      }, true);
    }

    let currentTab = 'overview';
    let currentProviderTab = 'cline';
    let wizardCurrentStep = 1;
    let wizardTargets = [];
    let allModels = [];
    let activeFilter = 'all';
    let allHarnesses = [];
    let currentUsagePeriod = 'today';
    let currentUsageMode = 'tokens';
    let usageStatsData = null;
    let usageProvidersData = [];
    let usageLogsData = [];
    let expandedProviders = new Set(['kilo', 'cline']);
    let quotaFilter = 'all';
    let quotaData = null;
    let providerQuotaData = [];
    let allAccountsData = [];
    const PROVIDER_LOGOS_MAP = ${JSON.stringify(PROVIDER_LOGOS)};

    // Toast feedback system
    function showToast(message, type = 'info') {
      const container = document.getElementById('toast-container');
      if (!container) return;
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => {
        toast.classList.add('lnl-toast-exit');
        setTimeout(() => toast.remove(), 200);
      }, 3500);
    }

    // Tab Navigation
    function switchNavTab(tabId) {
      if (!tabId || tabId === 'providers') tabId = 'plugins';
      let targetView = document.getElementById('view-' + tabId);
      if (!targetView) {
        tabId = 'overview';
        targetView = document.getElementById('view-overview');
      }
      currentTab = tabId;
      document.querySelectorAll('.tab-view').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

      if (targetView) targetView.classList.add('active');

      const targetNav = document.querySelector('.nav-item[data-tab="' + tabId + '"]');
      if (targetNav) targetNav.classList.add('active');

      if (window.location.hash !== '#' + tabId) {
        history.replaceState(null, '', '#' + tabId);
      }

      if (tabId === 'plugins') fetchPlugins();
      if (tabId === 'models' && allModels.length === 0) fetchModels();
      if (tabId === 'harnesses' && allHarnesses.length === 0) fetchHarnesses();
      if (tabId === 'telemetry') fetchTelemetry();
      if (tabId === 'usage') fetchUsageStats();
      if (tabId === 'quotas') fetchQuotas();
    }

    // Clipboard Copy
    async function copyToClipboard(text, label = 'Copied to clipboard!') {
      try {
        await navigator.clipboard.writeText(text);
        showToast(label, 'success');
      } catch (err) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(label, 'success');
      }
    }

    // =========================================================================
    // Free Models Explorer Engine (R2)
    // =========================================================================
    async function fetchModels() {
      try {
        const res = await fetch('/api/models');
        const json = await res.json();
        if (json.success && Array.isArray(json.models)) {
          allModels = json.models.filter((m) => m.available !== false);
          renderModelsGrid(allModels);
          const freeCount = allModels.filter(m => m.isFree).length;
          const oneMCount = allModels.filter(m => m.contextWindow >= 1000000).length;

          const counter = document.getElementById('models-free-counter');
          if (counter) counter.textContent = freeCount + ' Free Models Available ($0)';
          const kpi = document.getElementById('kpi-models');
          if (kpi) kpi.textContent = freeCount + ' Free';
          const kpiSub = document.getElementById('kpi-models-sub');
          if (kpiSub) kpiSub.textContent = oneMCount + ' with >=1M context';
          const navBadge = document.getElementById('badge-models-count');
          if (navBadge) navBadge.textContent = allModels.length + ' Models';

          const filterAll = document.getElementById('filter-models-all');
          if (filterAll) filterAll.textContent = 'All (' + allModels.length + ')';
          const filter1M = document.getElementById('filter-models-1m');
          if (filter1M) filter1M.textContent = '1M Context (' + oneMCount + ')';

          const hubContent = document.getElementById('hub-models-content');
          if (hubContent) hubContent.textContent = oneMCount + ' models with 1M+ token context from your configured providers.';
        }
      } catch (err) {
        console.error('fetchModels error:', err);
      }
    }

    function setModelsFilter(filter, btn) {
      activeFilter = filter;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      filterModels();
    }

    function filterModels() {
      const q = (document.getElementById('models-search')?.value || '').toLowerCase().trim();
      const p = document.getElementById('models-provider-filter')?.value || '';

      const filtered = allModels.filter(m => {
        // Tag filters
        if (activeFilter === '1m' && m.contextWindow < 1000000) return false;
        if (activeFilter === 'reasoning' && !m.supportsThinking && !m.tags.some(t => t.toLowerCase().includes('reasoning'))) return false;
        if (activeFilter === 'coding' && !m.tags.some(t => t.toLowerCase().includes('coding'))) return false;
        if (activeFilter === 'fast' && !m.tags.some(t => t.toLowerCase().includes('fast'))) return false;
        if (activeFilter === 'keyless' && m.providerId !== 'opencode' && !m.tags.some(t => t.toLowerCase().includes('keyless'))) return false;

        // Provider filter
        if (p && m.providerId !== p) return false;

        // Text search
        if (q) {
          const matchId = m.id.toLowerCase().includes(q);
          const matchName = (m.name || '').toLowerCase().includes(q);
          const matchTags = (m.tags || []).some(t => t.toLowerCase().includes(q));
          const matchProvider = (m.providerId || '').toLowerCase().includes(q);
          if (!matchId && !matchName && !matchTags && !matchProvider) return false;
        }

        return true;
      });

      renderModelsGrid(filtered);
    }

    function renderModelsGrid(models) {
      const grid = document.getElementById('models-grid-container');
      if (!grid) return;

      if (models.length === 0) {
        grid.innerHTML = '<div style="grid-column: 1/-1; padding: 32px; text-align: center; color: var(--text-tertiary);">No models matching your search criteria.</div>';
        return;
      }

      grid.innerHTML = models.map(m => {
        const badgesHtml = (m.badges || []).map(b =>
          '<span class="badge-tag ' + escapeHtml(b.color) + '">' + escapeHtml(b.text) + '</span>'
        ).join('');
        const safeId = escapeHtml(m.id);
        const domId = m.id.replace(/[^a-zA-Z0-9_-]/g, '_');

        return '' +
          '<div class="model-card" id="card-model-' + domId + '">' +
            '<div class="model-card-header">' +
              '<div>' +
                '<div class="model-card-title">' + escapeHtml(m.name || m.id) + '</div>' +
                '<div class="model-card-provider">' + escapeHtml(m.providerId) + ' Â· ' + escapeHtml(m.ownedBy) + '</div>' +
              '</div>' +
              '<div class="model-badges">' + badgesHtml + '</div>' +
            '</div>' +
            (m.description ? '<p style="font-size:0.78rem; color:var(--text-secondary);">' + escapeHtml(m.description) + '</p>' : '') +
            '<div class="model-id-box">' +
              '<span>' + safeId + '</span>' +
              '<button class="copy-btn" data-action="copy-model-id" data-id="' + safeId + '" title="Copy Model ID">' +
                '${ICONS.copy}' +
              '</button>' +
            '</div>' +
            '<div class="model-specs">' +
              '<span>Context: <strong>' + escapeHtml(m.contextWindowFormatted) + '</strong></span>' +
              '<div class="model-probe-status" id="probe-status-' + domId + '">' +
                '<button class="btn btn-secondary btn-sm" data-action="probe-model" data-id="' + safeId + '">' +
                  '${ICONS.play}' +
                  '<span>1-Click Test</span>' +
                '</button>' +
              '</div>' +
            '</div>' +
          '</div>';
      }).join('');
    }

    async function probeModelLive(modelId) {
      const safeId = modelId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const statusEl = document.getElementById('probe-status-' + safeId);
      if (statusEl) {
        statusEl.innerHTML = '<span class="status-pill zinc"><span class="status-dot zinc pulse"></span> Probing...</span>';
      }

      try {
        const res = await fetch('/api/models/probe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId }),
        });
        const data = await res.json();
        if (data.success) {
          if (statusEl) {
            statusEl.innerHTML = '<span class="status-pill emerald"><span class="status-dot emerald"></span> ' + data.latencyMs + 'ms Â· 200 OK</span>';
          }
          showToast('Probe OK (' + data.latencyMs + 'ms) for ' + modelId, 'success');
        } else {
          if (statusEl) {
            statusEl.innerHTML = '<span class="status-pill coral"><span class="status-dot coral"></span> ' + escapeHtml(data.error || 'Failed') + '</span>';
          }
          showToast('Probe failed: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        if (statusEl) {
          statusEl.innerHTML = '<span class="status-pill coral"><span class="status-dot coral"></span> Network error</span>';
        }
        showToast('Probe network error: ' + err.message, 'error');
      }
    }

    // =========================================================================
    // 1-Click Developer Harness Setup Engine (R3)
    // =========================================================================
    async function fetchHarnesses() {
      try {
        const res = await fetch('/api/harness/status');
        const json = await res.json();
        if (json.success && Array.isArray(json.harnesses)) {
          allHarnesses = json.harnesses;
          renderHarnessGrid(allHarnesses);
        }
      } catch (err) {
        console.error('fetchHarnesses error:', err);
      }
    }

    function refreshHarnessStatus() {
      showToast('Scanning local filesystem for developer tools...', 'info');
      fetchHarnesses();
    }

    function renderHarnessGrid(harnesses) {
      const container = document.getElementById('harness-grid-container');
      if (!container) return;

      container.innerHTML = harnesses.map(h => {
        let statusBadge = '<span class="status-pill zinc"><span class="status-dot zinc"></span> Not Detected</span>';
        if (h.configured) {
          statusBadge = '<span class="status-pill emerald"><span class="status-dot emerald"></span> Configured (Port 4000)</span>';
        } else if (h.detected) {
          statusBadge = '<span class="status-pill amber"><span class="status-dot amber"></span> Detected on Disk</span>';
        }

        const safeId = h.id.replace(/[^a-zA-Z0-9_-]/g, '_');

        return '' +
          '<div class="harness-card" id="harness-card-' + safeId + '">' +
            '<div class="harness-card-header">' +
              '<div class="harness-title-group">' +
                '<div class="harness-icon">${ICONS.terminal}</div>' +
                '<div>' +
                  '<div class="harness-name">' + escapeHtml(h.name) + '</div>' +
                  '<div class="harness-category">' + escapeHtml(h.category) + ' Â· ' + escapeHtml(h.protocol.toUpperCase()) + '</div>' +
                '</div>' +
              '</div>' +
              statusBadge +
            '</div>' +
            '<div class="harness-desc">' + escapeHtml(h.description) + '</div>' +
            '<div class="harness-path-box" title="' + escapeHtml(h.targetPath) + '">' + escapeHtml(h.targetPath) + '</div>' +
            '<div class="harness-actions">' +
              '<button class="btn btn-primary btn-sm" id="btn-setup-' + safeId + '" data-action="setup-harness" data-id="' + escapeHtml(h.id) + '">' +
                '${ICONS.zap}' +
                '<span>1-Click Setup</span>' +
              '</button>' +
              '<button class="btn btn-secondary btn-sm" data-action="toggle-snippet" data-id="' + safeId + '">' +
                '${ICONS.code}' +
                '<span>View Snippet</span>' +
              '</button>' +
              '<button class="btn btn-secondary btn-sm" data-action="copy-snippet-code" data-id="' + safeId + '" title="Copy configuration snippet">' +
                '${ICONS.copy}' +
              '</button>' +
            '</div>' +
            '<div class="snippet-box" id="snippet-box-' + safeId + '" style="display:none;">' +
              '<button class="btn btn-secondary btn-sm snippet-copy" data-action="copy-snippet-code" data-id="' + safeId + '">' +
                '${ICONS.copy} Copy' +
              '</button>' +
              '<code id="snippet-raw-' + safeId + '">' + escapeHtml(h.configSnippet) + '</code>' +
            '</div>' +
          '</div>';
      }).join('');
    }

    function toggleSnippetBox(safeId) {
      const box = document.getElementById('snippet-box-' + safeId);
      if (box) {
        box.classList.toggle('lnl-show-block', !box.classList.contains('lnl-show-block'));
      }
    }

    function copySnippetRaw(safeId) {
      const code = document.getElementById('snippet-raw-' + safeId)?.textContent || '';
      copyToClipboard(code, 'Configuration snippet copied!');
    }

    async function setupSingleHarness(harnessId) {
      const safeId = harnessId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const btn = document.getElementById('btn-setup-' + safeId);
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="status-dot emerald pulse"></span> Writing...';
      }

      try {
        const res = await fetch('/api/harness/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ harness: harnessId }),
        });
        const data = await res.json();
        if (data.success) {
          showToast(data.message, 'success');
          fetchHarnesses();
        } else {
          showToast('Failed to setup ' + harnessId + ': ' + (data.error || data.message), 'error');
        }
      } catch (err) {
        showToast('Error configuring ' + harnessId + ': ' + err.message, 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '${ICONS.zap} <span>1-Click Setup</span>';
        }
      }
    }

    async function setupAllHarnesses() {
      showToast('Configuring all detected developer harnesses...', 'info');
      try {
        const res = await fetch('/api/harness/setup-all', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('Successfully configured detected harnesses with backups!', 'success');
          fetchHarnesses();
        }
      } catch (err) {
        showToast('Batch setup error: ' + err.message, 'error');
      }
    }

    function escapeHtml(str) {
      return String(str ?? '').replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    // =========================================================================
    // Core REST API Calls: Accounts, Combos, Plugins, Telemetry
    // =========================================================================
    async function fetchAccounts() {
      try {
        const res = await fetch('/api/accounts');
        const json = await res.json();
        if (json.success && Array.isArray(json.accounts)) {
          allAccountsData = json.accounts;
          fetchPlugins();
          const pBadge = document.getElementById('badge-providers-count');
          if (pBadge) {
            const activeCount = json.accounts.filter(a => a.status === 'active').length;
            pBadge.textContent = activeCount + ' Connected';
          }
          const tbody = document.getElementById('accounts-table-body');
          if (tbody) {
            tbody.innerHTML = json.accounts.map(a => 
              '<tr>' +
                '<td style="font-family:var(--font-mono); font-weight:600; color:var(--text-primary);">' + escapeHtml(a.id) + '</td>' +
                '<td>' + escapeHtml(a.providerId) + '</td>' +
                '<td><span class="badge-tag zinc">' + escapeHtml(a.authType) + '</span></td>' +
                '<td><span class="status-pill ' + (a.status === 'active' ? 'emerald' : 'amber') + '">' + escapeHtml(a.status) + '</span></td>' +
                '<td>' + (a.errorCount || 0) + '</td>' +
                '<td style="font-family:var(--font-mono); font-size:0.75rem;">' + escapeHtml(a.credentials ? (a.credentials.email || a.credentials.apiKey || a.credentials.accessToken || 'configured') : 'configured') + '</td>' +
                '<td>' +
                  '<div style="display:flex; gap:6px;">' +
                    '<button class="btn btn-secondary btn-sm" data-action="test-account" data-id="' + escapeHtml(a.id) + '">Test</button>' +
                    '<button class="btn btn-danger btn-sm" data-action="delete-account" data-id="' + escapeHtml(a.id) + '">Delete</button>' +
                  '</div>' +
                '</td>' +
              '</tr>'
            ).join('');
          }
          const badge = document.getElementById('badge-accounts-count');
          if (badge) badge.textContent = json.accounts.length;
          const kpi = document.getElementById('kpi-accounts');
          if (kpi) kpi.textContent = json.accounts.filter(a => a.status === 'active').length + ' Active';
        }
      } catch (err) {
        console.error('fetchAccounts error:', err);
      }
    }

    async function testAccount(accountId) {
      showToast('Running health check probe for ' + accountId + '...', 'info');
      try {
        const res = await fetch('/api/accounts/' + encodeURIComponent(accountId) + '/test', { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          showToast('Health check passed for ' + accountId + ' (' + (json.health?.latencyMs || 0) + 'ms)', 'success');
        } else {
          showToast('Health check failed for ' + accountId + ': ' + (json.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        showToast('Probe network error: ' + err.message, 'error');
      }
    }

    async function deleteAccount(accountId) {
      if (!confirm('Remove account ' + accountId + '?')) return;
      try {
        const res = await fetch('/api/accounts/' + encodeURIComponent(accountId), { method: 'DELETE' });
        const json = await res.json();
        if (json.success) {
          showToast('Account removed', 'success');
          fetchAccounts();
        }
      } catch (err) {
        showToast('Delete error: ' + err.message, 'error');
      }
    }

    async function syncLocalAccounts() {
      const source = (window.prompt('Import source (jsonAccounts or sqlite9router):', 'jsonAccounts') || '').trim();
      if (!source) return;
      const path = (window.prompt('Full path to your accounts JSON export:') || '').trim();
      if (!path) return;
      try {
        const previewRes = await fetch('/api/accounts/import/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, path }),
        });
        const preview = await previewRes.json();
        if (!preview.success) {
          showToast('Import preview failed: ' + preview.error, 'error');
          return;
        }
        const ok = window.confirm(
          'Import ' + preview.count + ' account(s) from ' + preview.providers.join(', ') +
          '? No tokens or emails will be shown.'
        );
        if (!ok) return;
        const confirmRes = await fetch('/api/accounts/import/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: preview.token }),
        });
        const result = await confirmRes.json();
        if (result.success) {
          showToast('Imported ' + result.count + ' account(s)', 'success');
          fetchAccounts();
        } else {
          showToast('Import failed: ' + result.error, 'error');
        }
      } catch (err) {
        showToast('Import error: ' + err.message, 'error');
      }
    }

    async function fetchCombos() {
      try {
        const res = await fetch('/api/combos');
        const json = await res.json();
        if (json.success && Array.isArray(json.combos)) {
          const tbody = document.getElementById('combos-table-body');
          if (tbody) {
            tbody.innerHTML = json.combos.map(c => {
              const healthBadge = c.health === 'healthy'
                ? '<span class="status-pill emerald"><span class="status-dot emerald"></span> Healthy</span>'
                : c.health === 'degraded'
                ? '<span class="status-pill amber"><span class="status-dot amber"></span> Degraded</span>'
                : '<span class="status-pill coral"><span class="status-dot coral"></span> Exhausted</span>';

              const targetsHtml = (c.targetDetails && Array.isArray(c.targetDetails))
                ? c.targetDetails.map((td, idx) => {
                    let badgeClass = 'zinc';
                    let statusIcon = '&#x25CB;';
                    let tooltip = escapeHtml(td.target);
                    let depthBadge = '';
                    if (td.accountDepth && td.accountDepth.total > 0) {
                      depthBadge = ' <span style="opacity:0.8; font-size:0.68rem; margin-left:3px;">[' + td.accountDepth.active + '/' + td.accountDepth.total + ' accts]</span>';
                    } else if (td.availableAccounts !== undefined) {
                      depthBadge = ' <span style="opacity:0.8; font-size:0.68rem; margin-left:3px;">[' + td.availableAccounts + ' accts]</span>';
                    }

                    if (td.status === 'reachable') {
                      badgeClass = 'emerald';
                      statusIcon = '&#x2714;';
                      tooltip = escapeHtml(td.target + ' (Reachable - ' + (td.availableAccounts || td.accountDepth?.active || 0) + ' active accounts)');
                    } else if (td.status === 'cooldown') {
                      badgeClass = 'amber';
                      statusIcon = '&#x23F3;';
                      tooltip = escapeHtml(td.target + ' (In Cooldown' + (td.accountDepth?.lowestCooldownSec ? ' - ' + td.accountDepth.lowestCooldownSec + 's left' : '') + ')');
                    } else if (td.status === 'quota_exhausted') {
                      badgeClass = 'coral';
                      statusIcon = '&#x2716;';
                      tooltip = escapeHtml(td.target + ' (Quota Exhausted)');
                    } else if (td.status === 'disabled') {
                      badgeClass = 'zinc';
                      statusIcon = '&#x25CB;';
                      tooltip = escapeHtml(td.target + ' (Plugin Disabled)');
                    } else if (td.status === 'no_accounts') {
                      badgeClass = 'zinc';
                      statusIcon = '&#x25CB;';
                      tooltip = escapeHtml(td.target + ' (No Accounts Configured)');
                    }
                    const prefix = idx > 0 ? '<span style="color:var(--text-tertiary); font-size:0.75rem;">&rarr;</span>' : '';
                    return prefix + '<span class="badge-tag ' + badgeClass + '" title="' + tooltip + '" style="font-family:var(--font-mono);">' + statusIcon + ' ' + escapeHtml(td.target) + depthBadge + '</span>';
                  }).join(' ')
                : (c.targets || []).map(t => '<span class="badge-tag zinc">' + escapeHtml(t) + '</span>').join(' ');

              return '<tr>' +
                '<td style="font-family:var(--font-mono); font-weight:600; color:var(--cyan-text);">' + escapeHtml(c.id) + '</td>' +
                '<td>' + escapeHtml(c.name || c.id) + '</td>' +
                '<td>' + healthBadge + '</td>' +
                '<td><div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px;">' + targetsHtml + '</div></td>' +
                '<td>' +
                  '<button class="btn btn-danger btn-sm" data-action="delete-combo" data-id="' + encodeURIComponent(c.id) + '">Delete</button>' +
                '</td>' +
              '</tr>';
            }).join('');
          }
          const badge = document.getElementById('badge-combos-count');
          if (badge) badge.textContent = json.combos.length;
          const kpi = document.getElementById('kpi-combos');
          if (kpi) kpi.textContent = json.combos.length + ' Active';
        }
      } catch (err) {
        console.error('fetchCombos error:', err);
      }
    }

    async function deleteCombo(comboId) {
      if (!confirm('Delete virtual combo ' + decodeURIComponent(comboId) + '?')) return;
      try {
        const res = await fetch('/api/combos/' + comboId, { method: 'DELETE' });
        const json = await res.json();
        if (json.success) {
          showToast('Combo deleted', 'success');
          fetchCombos();
        }
      } catch (err) {
        showToast('Error deleting combo: ' + err.message, 'error');
      }
    }

    async function fetchPlugins() {
      try {
        const res = await fetch('/api/plugins');
        const json = await res.json();
        if (json.success && Array.isArray(json.plugins)) {
          const tbody = document.getElementById('plugins-table-body');
          const enabledCount = json.plugins.filter(p => p.enabled).length;
          const activeAccountsCount = allAccountsData.filter(a => a.status === 'active').length;

          if (tbody) {
            tbody.innerHTML = json.plugins.map(p => {
              const pAccounts = allAccountsData.filter(a => a.providerId === p.id);
              const pActiveAccounts = pAccounts.filter(a => a.status === 'active');
              const accountsCountStr = (p.id === 'lattice-combo' || p.id === 'lattice')
                ? '<span class="status-pill zinc">Virtual Cascade</span>'
                : pActiveAccounts.length > 0
                ? '<span class="status-pill emerald"><span class="status-dot emerald"></span> ' + pActiveAccounts.length + ' active</span>'
                : '<span class="status-pill zinc"><span class="status-dot zinc"></span> 0 accounts</span>';

              const authBadges = (p.supportedAuthTypes || []).map(t =>
                '<span class="badge-tag zinc" style="font-size:0.68rem;">' + escapeHtml(t) + '</span>'
              ).join(' ');

              const icon = PROVIDER_LOGOS_MAP[p.id] || '${ICONS.layers}';

              const connectBtn = (p.id !== 'lattice-combo' && p.id !== 'lattice')
                ? '<button class="btn btn-emerald btn-sm" data-call-click="openCredentialsModal(\\'' + escapeHtml(p.id) + '\\')">${ICONS.plus} Connect</button>'
                : '';

              return '<tr>' +
                '<td>' +
                  '<div style="display:flex; align-items:center; gap:10px;">' +
                    '<div style="width:28px; height:28px; border-radius:6px; background:var(--bg-canvas); border:1px solid var(--border-subtle); display:flex; align-items:center; justify-content:center; color:var(--text-primary); flex-shrink:0;">' + icon + '</div>' +
                    '<div>' +
                      '<div style="font-weight:600; color:var(--text-primary); font-size:0.88rem;">' + escapeHtml(p.displayName) + '</div>' +
                      '<div style="font-family:var(--font-mono); font-size:0.72rem; color:var(--text-tertiary);">' + escapeHtml(p.id) + '</div>' +
                    '</div>' +
                  '</div>' +
                '</td>' +
                '<td style="font-family:var(--font-mono); font-size:0.75rem; color:var(--text-secondary);">' + escapeHtml(p.defaultBaseUrl) + '</td>' +
                '<td><div style="display:flex; flex-wrap:wrap; gap:4px;">' + (authBadges || '<span style="color:var(--text-tertiary); font-size:0.75rem;">None</span>') + '</div></td>' +
                '<td>' + accountsCountStr + '</td>' +
                '<td><span class="status-pill ' + (p.enabled ? 'emerald' : 'zinc') + '"><span class="status-dot ' + (p.enabled ? 'emerald' : 'zinc') + '"></span> ' + (p.enabled ? 'Active' : 'Disabled') + '</span></td>' +
                '<td>' +
                  '<div style="display:flex; align-items:center; gap:6px;">' +
                    '<button class="btn btn-secondary btn-sm" data-action="toggle-plugin" data-id="' + escapeHtml(p.id) + '">' +
                      (p.enabled ? 'Disable' : 'Enable') +
                    '</button>' +
                    connectBtn +
                  '</div>' +
                '</td>' +
              '</tr>';
            }).join('');
          }

          // KPI Grid elements
          const kpiTotal = document.getElementById('plugins-kpi-total');
          if (kpiTotal) kpiTotal.textContent = json.plugins.length;
          const kpiActive = document.getElementById('plugins-kpi-active');
          if (kpiActive) kpiActive.textContent = enabledCount;
          const kpiAccounts = document.getElementById('plugins-kpi-accounts');
          if (kpiAccounts) kpiAccounts.textContent = activeAccountsCount;
          const kpiModels = document.getElementById('plugins-kpi-models');
          const freeCount = allModels.filter(m => m.isFree).length;
          if (kpiModels) kpiModels.textContent = freeCount > 0 ? (freeCount + ' Free') : '-- Free';

          // Badges
          const badgeNav = document.getElementById('badge-plugins-nav');
          if (badgeNav) badgeNav.textContent = enabledCount + ' Active';
          const badgePlugins = document.getElementById('badge-plugins-count');
          if (badgePlugins) badgePlugins.textContent = enabledCount;
          const kpi = document.getElementById('kpi-plugins');
          if (kpi) kpi.textContent = enabledCount + ' Active';
        }
      } catch (err) {
        console.error('fetchPlugins error:', err);
      }
    }

    async function togglePlugin(pluginId) {
      try {
        const res = await fetch('/api/plugins/' + pluginId + '/toggle', { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          showToast('Plugin ' + pluginId + ' state updated', 'success');
          fetchPlugins();
        }
      } catch (err) {
        showToast('Error toggling plugin: ' + err.message, 'error');
      }
    }

    async function fetchTelemetry() {
      try {
        const res = await fetch('/api/telemetry');
        const json = await res.json();
        if (json.success && json.telemetry) {
          const t = json.telemetry;
          const elTotal = document.getElementById('telem-total');
          const elPrompt = document.getElementById('telem-prompt');
          const elComp = document.getElementById('telem-completion');
          const elReqs = document.getElementById('telem-requests');
          const kpiTokens = document.getElementById('kpi-tokens');
          const kpiSaved = document.getElementById('kpi-saved');

          if (elTotal) elTotal.textContent = t.totalTokens.toLocaleString();
          if (elPrompt) elPrompt.textContent = t.promptTokens.toLocaleString();
          if (elComp) elComp.textContent = t.completionTokens.toLocaleString();
          if (elReqs) elReqs.textContent = t.totalRequests.toLocaleString();
          if (kpiTokens) kpiTokens.textContent = t.totalTokens.toLocaleString();
          if (kpiSaved) kpiSaved.textContent = '$' + t.savedUsd;

          const tbody = document.getElementById('telemetry-provider-tbody');
          if (tbody && t.providerTokens) {
            tbody.innerHTML = Object.entries(t.providerTokens).map(([p, data]) => 
              '<tr>' +
                '<td style="font-family:var(--font-mono); font-weight:600;">' + p + '</td>' +
                '<td>' + (data.prompt || 0).toLocaleString() + '</td>' +
                '<td>' + (data.completion || 0).toLocaleString() + '</td>' +
                '<td style="color:var(--text-primary); font-weight:600;">' + (data.total || 0).toLocaleString() + '</td>' +
                '<td style="color:var(--emerald-text); font-family:var(--font-mono); font-weight:600;">$' + ((data.total || 0) * (t.usdPerToken || 0)).toFixed(2) + '</td>' +
              '</tr>'
            ).join('');
          }
        }
      } catch (err) {
        console.error('fetchTelemetry error:', err);
      }
    }

    async function triggerSimulatedPing() {
      showToast('Emitting simulated load ping across gateway ingress...', 'info');
      try {
        const res = await fetch('/api/telemetry/simulate', { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          showToast('Simulated packet emitted (' + json.log.totalTokens + ' tokens, ' + json.log.latencyMs + 'ms)', 'success');
          fetchTelemetry();
        }
      } catch (err) {
        showToast('Simulation error: ' + err.message, 'error');
      }
    }

    // =========================================================================
    // Token Usage & Analytics Engine (R3)
    // =========================================================================
    async function fetchUsageStats() {
      try {
        const [statsRes, provRes, logsRes] = await Promise.all([
          fetch('/api/usage/stats?period=' + currentUsagePeriod),
          fetch('/api/usage/providers'),
          fetch('/api/usage/logs?page=1&pageSize=20')
        ]);
        if (statsRes.ok) {
          const statsJson = await statsRes.json();
          if (statsJson.success) usageStatsData = statsJson;
        }
        if (provRes.ok) {
          const provJson = await provRes.json();
          if (provJson.success) usageProvidersData = provJson.providers || [];
        }
        if (logsRes.ok) {
          const logsJson = await logsRes.json();
          if (logsJson.success) usageLogsData = logsJson.logs || [];
        }
        renderUsageView();
      } catch (err) {
        console.error('Failed to fetch usage data:', err);
      }
    }

    function setUsagePeriod(period) {
      currentUsagePeriod = period;
      document.querySelectorAll('#usage-period-pills .filter-pill').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.toLowerCase() === period.toLowerCase());
      });
      fetchUsageStats();
    }

    function toggleUsageMode(mode) {
      currentUsageMode = mode;
      document.getElementById('btn-mode-tokens')?.classList.toggle('active', mode === 'tokens');
      document.getElementById('btn-mode-cost')?.classList.toggle('active', mode === 'cost');
      renderUsageView();
    }

    function toggleProviderAccordion(providerId) {
      if (expandedProviders.has(providerId)) {
        expandedProviders.delete(providerId);
      } else {
        expandedProviders.add(providerId);
      }
      renderUsageView();
    }

    function renderUsageView() {
      if (!usageStatsData) return;
      const stats = usageStatsData.stats;
      const providers = usageStatsData.providers;

      // Update KPIs
      const elReqs = document.getElementById('usage-kpi-requests');
      if (elReqs) elReqs.textContent = (stats.totalRequests || 0).toLocaleString();

      const elPrompt = document.getElementById('usage-kpi-prompt');
      if (elPrompt) elPrompt.textContent = (stats.totalPromptTokens || 0).toLocaleString();

      const elCached = document.getElementById('usage-kpi-cached');
      if (elCached) elCached.textContent = (stats.totalCachedTokens || 0).toLocaleString();

      const elComp = document.getElementById('usage-kpi-completion');
      if (elComp) elComp.textContent = (stats.totalCompletionTokens || 0).toLocaleString();

      const elCost = document.getElementById('usage-kpi-cost');
      if (elCost) elCost.textContent = '~$' + (stats.totalCostSaved || 0).toFixed(2);

      // Update distribution track & legend
      const track = document.getElementById('usage-distribution-track');
      const legend = document.getElementById('usage-distribution-legend');
      const sum = document.getElementById('usage-dist-summary');
      if (sum) sum.textContent = 'Total: ' + (stats.totalTokens || 0).toLocaleString() + ' tokens';

      const pColors = {
        kilo: '#10b981',
        nous: '#f59e0b',
        cline: '#06b6d4',
        opencode: '#a855f7',
        deepseek: '#3b82f6',
      };
      const pNames = {
        kilo: 'Kilo Code',
        nous: 'Nous Research',
        cline: 'Cline Free Pool',
        opencode: 'OpenCode Zen',
        deepseek: 'DeepSeek Web',
      };

      if (track && legend && providers) {
        let trackHtml = '';
        let legendHtml = '';
        const total = stats.totalTokens || 1;
        for (const [p, pStat] of Object.entries(providers)) {
          const pct = Math.max(1, Math.round(((pStat.total || 0) / total) * 100));
          const color = pColors[p] || '#71717a';
          const name = pNames[p] || p;
          trackHtml += '<div class="distribution-segment" style="width: ' + pct + '%; background: ' + color + ';" title="' + escapeHtml(name) + ': ' + pct + '% (' + (pStat.total || 0).toLocaleString() + ' tokens)"></div>';
          legendHtml += '<div class="legend-item"><span class="legend-dot" style="background: ' + color + ';"></span><span>' + escapeHtml(name) + ': <strong>' + pct + '%</strong></span></div>';
        }
        track.innerHTML = trackHtml;
        legend.innerHTML = legendHtml;
      }

      // Render Real Token Usage Chart (Phase 7)
      const chartContainer = document.getElementById('usage-chart-container');
      if (chartContainer && usageProvidersData && usageProvidersData.length > 0) {
        let chartHtml = '';
        const grandTotal = stats.totalTokens || 1;

        for (const p of usageProvidersData) {
          const pTotal = p.totalTokens || 0;
          const pPrompt = p.promptTokens || 0;
          const pCompletion = p.completionTokens || 0;
          const pCached = p.cachedTokens || 0;
          const pRequests = p.requests || 0;

          const promptPct = pTotal > 0 ? Math.round((pPrompt / pTotal) * 100) : 0;
          const completionPct = pTotal > 0 ? Math.max(0, 100 - promptPct) : 0;
          const sharePct = Math.round((pTotal / grandTotal) * 100);

          chartHtml += '<div class="token-chart-row">' +
            '<div class="token-chart-header">' +
              '<div class="token-chart-provider-name">' +
                '<span>' + escapeHtml(p.name) + '</span>' +
                '<span class="badge-tag zinc" style="font-size:0.68rem; font-family:var(--font-mono);">' + escapeHtml(p.id) + '</span>' +
                '<span style="font-size:0.72rem; color:var(--text-tertiary); font-family:var(--font-mono);">' + sharePct + '% gateway volume</span>' +
              '</div>' +
              '<div class="token-chart-totals">' +
                '<span style="color:var(--text-primary); font-weight:700;">' + pTotal.toLocaleString() + '</span> total tokens &bull; ' +
                '<span>' + pRequests.toLocaleString() + ' reqs</span> &bull; ' +
                '<span style="color:var(--amber-text);">$' + (p.costSaved || 0).toFixed(2) + ' saved</span>' +
              '</div>' +
            '</div>' +
            '<div class="token-stacked-bar">' +
              '<div class="token-stacked-segment" style="width: ' + promptPct + '%; background: var(--cyan-text);" title="Input: ' + pPrompt.toLocaleString() + ' tokens (' + promptPct + '%)"></div>' +
              '<div class="token-stacked-segment" style="width: ' + completionPct + '%; background: var(--emerald-text);" title="Output: ' + pCompletion.toLocaleString() + ' tokens (' + completionPct + '%)"></div>' +
            '</div>' +
            '<div class="token-chart-subbars">' +
              '<div class="token-subbar-metric"><span class="legend-dot" style="background:var(--cyan-text);"></span><span>Input (Prompt): <strong>' + pPrompt.toLocaleString() + '</strong> (' + promptPct + '%)</span></div>' +
              '<div class="token-subbar-metric"><span class="legend-dot" style="background:#60a5fa;"></span><span>Cached: <strong>' + pCached.toLocaleString() + '</strong></span></div>' +
              '<div class="token-subbar-metric"><span class="legend-dot" style="background:var(--emerald-text);"></span><span>Output (Completion): <strong>' + pCompletion.toLocaleString() + '</strong> (' + completionPct + '%)</span></div>' +
            '</div>' +
          '</div>';
        }

        chartContainer.innerHTML = chartHtml;
      }

      // Render Model Breakdown Table
      const tbody = document.getElementById('usage-breakdown-tbody');
      const filterEl = document.getElementById('usage-provider-filter');
      const filterVal = filterEl ? filterEl.value : 'all';

      if (tbody) {
        let html = '';
        for (const p of usageProvidersData) {
          if (filterVal !== 'all' && p.id !== filterVal) continue;
          const isExpanded = expandedProviders.has(p.id);
          const chevronClass = isExpanded ? 'chevron-icon expanded' : 'chevron-icon';
          const chevronSvg = '<span class="' + chevronClass + '">${ICONS.chevronRight}</span>';
          const pBadge = '<span class="badge-tag zinc" style="margin-left:6px;">' + (p.models?.length || 0) + ' models</span>';

          html += '<tr class="accordion-row" data-action="toggle-accordion" data-id="' + escapeHtml(p.id) + '" style="background: var(--bg-surface-elevated); font-weight: 600; cursor: pointer;">' +
            '<td><div style="display:flex; align-items:center; gap:8px;">' + chevronSvg + '<span>' + escapeHtml(p.name) + '</span>' + pBadge + '</div></td>' +
            '<td style="text-align: right; font-family: var(--font-mono); color: var(--cyan-text);">' + p.promptTokens.toLocaleString() + '</td>' +
            '<td style="text-align: right; font-family: var(--font-mono); color: #60a5fa;">' + p.cachedTokens.toLocaleString() + '</td>' +
            '<td style="text-align: right; font-family: var(--font-mono); color: var(--emerald-text);">' + p.completionTokens.toLocaleString() + '</td>' +
            '<td style="text-align: right; font-family: var(--font-mono); font-weight: 700;">' + p.totalTokens.toLocaleString() + '</td>' +
            '<td style="text-align: right; font-family: var(--font-mono); color: var(--amber-text);">$' + p.costSaved.toFixed(2) + '</td>' +
            '<td style="text-align: right; font-family: var(--font-mono);">' + p.requests.toLocaleString() + '</td>' +
          '</tr>';

          if (isExpanded && p.models) {
            for (const m of p.models) {
              html += '<tr class="accordion-nested-row">' +
                '<td style="padding-left: 36px;">' +
                  '<div style="display:flex; align-items:center; gap:6px;">' +
                    '<span style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-primary);">' + escapeHtml(m.id) + '</span>' +
                    '<span class="badge-tag zinc" style="font-size: 0.65rem;">' + (m.contextWindowFormatted || '128k') + '</span>' +
                  '</div>' +
                '</td>' +
                '<td style="text-align: right; font-family: var(--font-mono); color: var(--text-secondary); font-size: 0.78rem;">' + m.promptTokens.toLocaleString() + '</td>' +
                '<td style="text-align: right; font-family: var(--font-mono); color: var(--text-secondary); font-size: 0.78rem;">' + m.cachedTokens.toLocaleString() + '</td>' +
                '<td style="text-align: right; font-family: var(--font-mono); color: var(--text-secondary); font-size: 0.78rem;">' + m.completionTokens.toLocaleString() + '</td>' +
                '<td style="text-align: right; font-family: var(--font-mono); font-size: 0.78rem;">' + m.totalTokens.toLocaleString() + '</td>' +
                '<td style="text-align: right; font-family: var(--font-mono); color: var(--amber-text); font-size: 0.78rem;">$' + m.costSaved.toFixed(2) + '</td>' +
                '<td style="text-align: right; font-family: var(--font-mono); font-size: 0.78rem;">' + m.requests.toLocaleString() + '</td>' +
              '</tr>';
            }
          }
        }
        tbody.innerHTML = html;
      }

      // Render Logs Table
      const logsTbody = document.getElementById('usage-logs-tbody');
      if (logsTbody) {
        let logsHtml = '';
        usageLogsData.forEach((l, idx) => {
          const timeStr = new Date(l.timestamp).toLocaleTimeString();
          const statusBadge = l.status === 200
            ? '<span class="status-pill emerald"><span class="status-dot emerald"></span> 200 OK</span>'
            : '<span class="status-pill coral"><span class="status-dot coral"></span> ' + escapeHtml(l.status) + '</span>';

          logsHtml += '<tr>' +
            '<td style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-tertiary);">' + escapeHtml(timeStr) + '</td>' +
            '<td style="font-family: var(--font-mono); font-size: 0.78rem;"><span style="color:var(--text-tertiary);">' + escapeHtml(l.method || 'POST') + '</span> ' + escapeHtml(l.path || '/v1/chat/completions') + '</td>' +
            '<td><span class="badge-tag zinc">' + escapeHtml(l.provider || 'kilo') + '</span></td>' +
            '<td style="font-family: var(--font-mono); font-size: 0.78rem; font-weight: 500;">' + escapeHtml(l.model || 'unknown') + '</td>' +
            '<td style="text-align: right; font-family: var(--font-mono); font-size: 0.78rem; color: var(--cyan-text);">' + escapeHtml((l.promptTokens || 0).toLocaleString()) + '</td>' +
            '<td style="text-align: right; font-family: var(--font-mono); font-size: 0.78rem; color: var(--emerald-text);">' + escapeHtml((l.completionTokens || 0).toLocaleString()) + '</td>' +
            '<td style="text-align: right; font-family: var(--font-mono); font-size: 0.78rem; color: var(--amber-text);">' + escapeHtml(l.latencyMs || 45) + 'ms</td>' +
            '<td>' + statusBadge + '</td>' +
            '<td style="text-align: center;"><button class="btn btn-secondary btn-sm" data-call-click="showRequestDetailModal(' + idx + ')">Detail</button></td>' +
          '</tr>';
        });
        logsTbody.innerHTML = logsHtml;
      }
    }

    function showRequestDetailModal(logIndex) {
      const log = usageLogsData[logIndex];
      if (!log) return;

      const modal = document.getElementById('modal-request-detail');
      const subtitle = document.getElementById('req-modal-subtitle');
      const overview = document.getElementById('req-modal-overview');
      const payload = document.getElementById('req-modal-payload');
      const response = document.getElementById('req-modal-response');

      if (subtitle) subtitle.textContent = (log.provider || 'kilo') + ' - ' + (log.model || 'unknown') + ' (' + (log.latencyMs || 45) + 'ms)';
      if (overview) {
        overview.innerHTML = '<div><strong>Timestamp:</strong> ' + new Date(log.timestamp).toISOString() + '</div>' +
          '<div><strong>Latency:</strong> ' + (log.latencyMs || 45) + 'ms</div>' +
          '<div><strong>Tokens:</strong> ' + (log.promptTokens || 0) + ' in / ' + (log.completionTokens || 0) + ' out (' + (log.totalTokens || 0) + ' total)</div>' +
          '<div><strong>Status:</strong> ' + (log.status || 200) + ' OK</div>';
      }
      if (payload) {
        payload.textContent = JSON.stringify({
          model: log.model,
          messages: [
            { role: 'system', content: 'You are an authentic intelligence assistant.' },
            { role: 'user', content: 'Ping verification probe for latency & token counting.' }
          ],
          stream: true,
          temperature: 0.7
        }, null, 2);
      }
      if (response) {
        response.textContent = JSON.stringify({
          id: 'chatcmpl_' + log.timestamp,
          object: 'chat.completion',
          model: log.model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: log.message || ('Processed inference through ' + (log.provider || 'kilo') + ' engine with ' + (log.completionTokens || 0) + ' output tokens.')
            },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: log.promptTokens,
            completion_tokens: log.completionTokens,
            total_tokens: log.totalTokens
          }
        }, null, 2);
      }

      if (modal) modal.classList.add('open');
    }

    function closeRequestDetailModal(event) {
      if (event && event.target && event.target.id !== 'modal-request-detail') return;
      const modal = document.getElementById('modal-request-detail');
      if (modal) modal.classList.remove('open');
    }

    // =========================================================================
    // Quota Tracker Engine (R4)
    // =========================================================================
    async function fetchQuotas() {
      try {
        const [resQuotas, resProviderQuota] = await Promise.all([
          fetch('/api/quotas'),
          fetch('/api/quota').catch(() => null),
        ]);
        if (resQuotas && resQuotas.ok) {
          const json = await resQuotas.json();
          if (json.success) quotaData = json;
        }
        if (resProviderQuota && resProviderQuota.ok) {
          const pJson = await resProviderQuota.json();
          if (pJson.success && Array.isArray(pJson.providers)) {
            providerQuotaData = pJson.providers;
          }
        }
        renderQuotasView();
      } catch (err) {
        console.error('Failed to fetch quotas:', err);
      }
    }

    function filterQuotas(filter) {
      quotaFilter = filter;
      document.querySelectorAll('#quota-filter-pills .filter-pill').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.toLowerCase().includes(filter.toLowerCase()));
      });
      renderQuotasView();
    }

    async function resetQuotaCooldown(accountId) {
      try {
        const res = await fetch('/api/quotas/' + encodeURIComponent(accountId) + '/reset-cooldown', { method: 'POST' });
        if (res.ok) {
          showToast('Cooldown cleared for ' + accountId, 'success');
          fetchQuotas();
        } else {
          showToast('Failed to clear cooldown', 'error');
        }
      } catch (err) {
        showToast('Network error resetting cooldown', 'error');
      }
    }

    function renderQuotasView() {
      if (!quotaData) return;
      const summary = quotaData.summary || {};
      const quotas = quotaData.quotas || [];

      // Update summary cards
      const elTot = document.getElementById('quota-sum-total');
      if (elTot) elTot.textContent = summary.totalAccounts || quotas.length;

      const elAct = document.getElementById('quota-sum-active');
      if (elAct) elAct.textContent = summary.activeAccounts || 0;

      const elHlt = document.getElementById('quota-sum-healthy');
      if (elHlt) elHlt.textContent = summary.healthyQuotas || 0;

      const elCld = document.getElementById('quota-sum-cooldown');
      if (elCld) elCld.textContent = summary.cooldownAccounts || 0;

      const badgeNav = document.getElementById('badge-quotas-health');
      if (badgeNav) {
        if (summary.cooldownAccounts > 0) {
          badgeNav.className = 'nav-badge amber';
          badgeNav.textContent = summary.cooldownAccounts + ' In Cooldown';
        } else {
          badgeNav.className = 'nav-badge emerald';
          badgeNav.textContent = (summary.activeAccounts || 0) + ' Active';
        }
      }

      // Render Provider Quota Overview Panel (Phase 7)
      const providerContainer = document.getElementById('provider-quota-cards-container');
      const badgeProviderStatus = document.getElementById('badge-provider-quota-status');
      if (providerContainer && providerQuotaData && providerQuotaData.length > 0) {
        let hasExhausted = false;
        let hasWarning = false;
        let pCardsHtml = '';

        for (const p of providerQuotaData) {
          if (p.status === 'exhausted') hasExhausted = true;
          if (p.status === 'warning' || p.status === 'critical') hasWarning = true;

          const pStatusBadge = p.status === 'exhausted'
            ? '<span class="status-pill coral"><span class="status-dot coral"></span> Exhausted</span>'
            : p.status === 'critical'
            ? '<span class="status-pill coral"><span class="status-dot coral"></span> Critical</span>'
            : p.status === 'warning'
            ? '<span class="status-pill amber"><span class="status-dot amber"></span> Warning</span>'
            : '<span class="status-pill emerald"><span class="status-dot emerald"></span> Healthy</span>';

          const pName = p.providerId.toUpperCase();
          const pThresholdClass = 'threshold-' + (p.status === 'exhausted' ? 'critical' : p.status);

          let capacityText = 'Unlimited / Pay-As-You-Go';
          let barFillWidth = 100;
          let barThreshold = 'threshold-unlimited';

          if (p.quotaLimit !== undefined && p.quotaLimit > 0) {
            const rem = p.quotaRemaining !== undefined ? p.quotaRemaining : 0;
            const pct = p.quotaPercent !== undefined ? p.quotaPercent : Math.round((rem / p.quotaLimit) * 100);
            capacityText = rem.toLocaleString() + ' / ' + p.quotaLimit.toLocaleString() + ' rem (' + pct + '%)';
            barFillWidth = Math.min(100, Math.max(2, pct));
            barThreshold = pThresholdClass;
          }

          let resetText = 'Rolling window / Active';
          if (p.nextResetAt) {
            const sec = Math.max(0, Math.round((p.nextResetAt - Date.now()) / 1000));
            let countdown = sec + 's';
            if (sec >= 60) {
              const m = Math.floor(sec / 60);
              const s = sec % 60;
              countdown = m + 'm ' + s + 's';
            }
            resetText = 'Reset: in ' + countdown + ' (' + new Date(p.nextResetAt).toLocaleTimeString() + ')';
          }

          let accountsNote = p.activeAccounts + ' / ' + p.totalAccounts + ' accounts active';
          if (p.cooldownAccounts > 0) {
            accountsNote += ' <span style="color:var(--amber-text);">(' + p.cooldownAccounts + ' in cooldown)</span>';
          }
          if (p.quotaExhaustedAccounts > 0) {
            accountsNote += ' <span style="color:var(--coral-text);">(' + p.quotaExhaustedAccounts + ' exhausted)</span>';
          }

          pCardsHtml += '<div class="quota-card">' +
            '<div class="quota-card-header">' +
              '<div>' +
                '<div class="quota-card-title" style="display:flex; align-items:center; gap:8px;">' +
                  '<span>' + pName + '</span>' +
                  '<span class="badge-tag zinc" style="font-size:0.68rem; font-family:var(--font-mono);">' + p.providerId + '</span>' +
                '</div>' +
                '<div style="font-size:0.75rem; color:var(--text-tertiary); margin-top:2px;">' + accountsNote + '</div>' +
              '</div>' +
              '<div>' + pStatusBadge + '</div>' +
            '</div>' +
            '<div class="quota-item">' +
              '<div class="quota-item-header">' +
                '<span class="quota-item-name">Quota Capacity</span>' +
                '<span class="quota-item-meta">' + capacityText + '</span>' +
              '</div>' +
              '<div class="quota-bar-track">' +
                '<div class="quota-bar-fill ' + barThreshold + '" style="width: ' + barFillWidth + '%;"></div>' +
              '</div>' +
              '<div class="quota-reset-schedule">' +
                '${ICONS.clock}' +
                '<span>' + resetText + '</span>' +
              '</div>' +
            '</div>' +
            '<div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid var(--border-subtle); padding-top:10px; font-size:0.75rem; font-family:var(--font-mono);">' +
              '<div><span style="color:var(--text-tertiary);">Real Tokens:</span> <span style="color:var(--cyan-text); font-weight:600;">' + (p.tokensUsed || 0).toLocaleString() + '</span> <span style="color:var(--text-tertiary); font-size:0.7rem;">(' + (p.promptTokens || 0).toLocaleString() + ' in / ' + (p.completionTokens || 0).toLocaleString() + ' out)</span></div>' +
              '<div><span style="color:var(--text-tertiary);">Requests:</span> <span style="color:var(--text-primary); font-weight:600;">' + (p.requestsUsed || 0) + '</span></div>' +
            '</div>' +
          '</div>';
        }

        providerContainer.innerHTML = pCardsHtml;

        if (badgeProviderStatus) {
          if (hasExhausted) {
            badgeProviderStatus.className = 'badge-tag coral';
            badgeProviderStatus.textContent = 'Quota Exhausted';
          } else if (hasWarning) {
            badgeProviderStatus.className = 'badge-tag amber';
            badgeProviderStatus.textContent = 'Degraded Quota';
          } else {
            badgeProviderStatus.className = 'badge-tag emerald';
            badgeProviderStatus.textContent = 'All Providers Healthy';
          }
        }
      }

      // Filter quotas
      let filtered = quotas;
      if (quotaFilter === 'active') {
        filtered = filtered.filter(q => q.status === 'active');
      } else if (quotaFilter === 'cooldown') {
        filtered = filtered.filter(q => q.inCooldown || q.status === 'cooldown');
      }

      const container = document.getElementById('quota-cards-container');
      if (!container) return;

      if (filtered.length === 0) {
        container.innerHTML = '<div style="color:var(--text-tertiary); font-size:0.85rem; padding:20px;">No accounts match the current filter.</div>';
        return;
      }

      let cardsHtml = '';
      for (const card of filtered) {
        const statusBadge = card.inCooldown || card.status === 'cooldown'
          ? '<span class="status-pill coral"><span class="status-dot coral"></span> In Cooldown (' + (card.cooldownRemainingSeconds || 30) + 's)</span>'
          : card.status === 'active'
          ? '<span class="status-pill emerald"><span class="status-dot emerald"></span> Active</span>'
          : '<span class="status-pill zinc">' + escapeHtml(card.status) + '</span>';

        let itemsHtml = '';
        for (const item of card.items) {
          const thresholdClass = 'threshold-' + (item.threshold || 'healthy');
          const resetIcon = '${ICONS.clock}';

          itemsHtml += '<div class="quota-item">' +
            '<div class="quota-item-header">' +
              '<span class="quota-item-name">' + escapeHtml(item.name) + '</span>' +
              '<span class="quota-item-meta">' + item.percentage + '% rem (' + item.remaining.toLocaleString() + ' / ' + item.total.toLocaleString() + ' ' + escapeHtml(item.unit) + ')</span>' +
            '</div>' +
            '<div class="quota-bar-track">' +
              '<div class="quota-bar-fill ' + thresholdClass + '" style="width: ' + Math.min(100, Math.max(2, item.percentage)) + '%;"></div>' +
            '</div>' +
            '<div class="quota-reset-schedule">' +
              resetIcon +
              '<span>Reset: ' + escapeHtml(item.resetFormatted) + '</span>' +
            '</div>' +
          '</div>';
        }

        const actionBtn = card.inCooldown || card.status === 'cooldown'
          ? '<button class="btn btn-emerald btn-sm" data-action="reset-quota" data-id="' + escapeHtml(card.accountId) + '" style="margin-top:6px;">${ICONS.play} Reset Cooldown</button>'
          : '';

        cardsHtml += '<div class="quota-card">' +
          '<div class="quota-card-header">' +
            '<div>' +
              '<div class="quota-card-title">' + escapeHtml(card.name) + '</div>' +
              '<div class="quota-card-email" title="' + escapeHtml(card.email) + '">' + escapeHtml(card.email) + '</div>' +
            '</div>' +
            '<div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">' +
              statusBadge +
              '<span class="badge-tag zinc" style="font-size:0.65rem;">Auth: ' + escapeHtml(card.authType) + '</span>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex; flex-direction:column; gap:12px; margin-top:4px;">' +
            itemsHtml +
          '</div>' +
          actionBtn +
        '</div>';
      }

      container.innerHTML = cardsHtml;
    }

    // Live Ingress SSE Terminal
    function initLogStream() {
      const terminal = document.getElementById('terminal-logs');
      if (!terminal) return;

      try {
        const es = new EventSource('/api/logs/stream');
        es.onmessage = (event) => {
          if (!event.data || event.data === ': connected') return;
          try {
            const log = JSON.parse(event.data);
            const line = document.createElement('div');
            line.className = 'log-line';
            line.innerHTML = '' +
              '<span class="log-time">' + escapeHtml(new Date(log.timestamp).toLocaleTimeString()) + '</span>' +
              '<span class="log-method">' + escapeHtml(log.method) + '</span>' +
              '<span class="log-path">' + escapeHtml(log.path) + '</span>' +
              '<span class="badge-tag zinc">' + escapeHtml(log.model) + '</span>' +
              '<span class="log-meta">' +
                '<span class="status-pill ' + (log.status === 200 ? 'emerald' : 'coral') + '">' + escapeHtml(log.status) + '</span>' +
                '<span>' + escapeHtml(log.latencyMs) + 'ms</span>' +
                '<span style="color:var(--cyan-text);">' + escapeHtml(log.totalTokens || 0) + ' tok</span>' +
              '</span>';
            terminal.prepend(line);
            if (terminal.children.length > 200) terminal.removeChild(terminal.lastChild);
          } catch {}
        };
      } catch (e) {
        console.error('SSE connection error:', e);
      }
    }

    function clearLogs() {
      const term = document.getElementById('terminal-logs');
      if (term) term.innerHTML = '';
      showToast('Live stream buffer cleared', 'info');
    }

    // =========================================================================
    // Credentials Modal & Provider Fields
    // =========================================================================
    function openCredentialsModal(preselectProvider) {
      const modal = document.getElementById('modal-credentials');
      if (modal) {
        modal.classList.add('open');
        modal.classList.add('active');
      }
      if (preselectProvider) {
        switchProviderTab(preselectProvider);
      } else {
        switchProviderTab(currentProviderTab || 'cline');
      }
    }

    function closeCredentialsModal() {
      const modal = document.getElementById('modal-credentials');
      if (modal) {
        modal.classList.remove('open');
        modal.classList.remove('active');
      }
    }

    function switchProviderTab(provider) {
      currentProviderTab = provider;
      document.querySelectorAll('.provider-tab-btn').forEach(btn => btn.classList.remove('active'));
      const activeBtn = document.getElementById('tab-btn-' + provider);
      if (activeBtn) activeBtn.classList.add('active');

      const container = document.getElementById('provider-fields-container');
      if (!container) return;

      if (provider === 'kilo') {
        container.innerHTML = '' +
          '<div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:6px; padding:12px; margin-bottom:12px;">' +
            '<div style="font-weight:600; font-size:0.85rem; color:var(--text-primary); margin-bottom:4px;">1-Click Kilo Device Authorization</div>' +
            '<p style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:10px;">Click below to launch official Kilo device authorization in your browser.</p>' +
            '<button type="button" class="btn btn-emerald btn-sm" data-action="start-oauth" data-provider="kilo">Start OAuth Device Login</button>' +
            '<div id="oauth-status-kilo" style="margin-top:8px; font-size:0.75rem; font-family:var(--font-mono);"></div>' +
          '</div>' +
          '<div style="display:flex; align-items:center; gap:8px; margin: 12px 0 8px;">' +
            '<div style="flex:1; height:1px; background:var(--border-subtle);"></div>' +
            '<span style="font-size:0.72rem; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:0.05em;">Or Connect With API Key</span>' +
            '<div style="flex:1; height:1px; background:var(--border-subtle);"></div>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">Account ID</label>' +
            '<input type="text" class="form-input" id="acc-id" placeholder="acc_kilo_primary">' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Kilo API Key / Bearer Token</label>' +
            '<input type="password" class="form-input" id="acc-key" placeholder="sk-kilo-...">' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Organization ID (Optional)</label>' +
            '<input type="text" class="form-input" id="acc-org" placeholder="org_...">' +
          '</div>';
      } else if (provider === 'cline') {
        container.innerHTML = '' +
          '<div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:6px; padding:12px; margin-bottom:12px;">' +
            '<div style="font-weight:600; font-size:0.85rem; color:var(--text-primary); margin-bottom:4px;">1-Click WorkOS Device Authorization</div>' +
            '<p style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:10px;">Click below to launch official WorkOS device authentication in your default browser.</p>' +
            '<button type="button" class="btn btn-emerald btn-sm" data-action="start-oauth" data-provider="cline">Start OAuth Device Login</button>' +
            '<div id="oauth-status-cline" style="margin-top:8px; font-size:0.75rem; font-family:var(--font-mono);"></div>' +
          '</div>' +
          '<div style="display:flex; align-items:center; gap:8px; margin: 12px 0 8px;">' +
            '<div style="flex:1; height:1px; background:var(--border-subtle);"></div>' +
            '<span style="font-size:0.72rem; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:0.05em;">Or Manual Access Token</span>' +
            '<div style="flex:1; height:1px; background:var(--border-subtle);"></div>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">Account ID</label>' +
            '<input type="text" class="form-input" id="acc-id" placeholder="acc_cline_manual">' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">WorkOS Access Token</label>' +
            '<input type="password" class="form-input" id="acc-key" placeholder="Bearer eyJ...">' +
          '</div>';
      } else if (provider === 'nous') {
        container.innerHTML = '' +
          '<div style="background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:6px; padding:12px; margin-bottom:12px;">' +
            '<div style="font-weight:600; font-size:0.85rem; color:var(--text-primary); margin-bottom:4px;">1-Click Nous Portal Device Auth</div>' +
            '<p style="font-size:0.78rem; color:var(--text-secondary); margin-bottom:10px;">Click below to launch official Nous Portal session authentication.</p>' +
            '<button type="button" class="btn btn-emerald btn-sm" data-action="start-oauth" data-provider="nous">Start OAuth Device Login</button>' +
            '<div id="oauth-status-nous" style="margin-top:8px; font-size:0.75rem; font-family:var(--font-mono);"></div>' +
          '</div>' +
          '<div style="display:flex; align-items:center; gap:8px; margin: 12px 0 8px;">' +
            '<div style="flex:1; height:1px; background:var(--border-subtle);"></div>' +
            '<span style="font-size:0.72rem; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:0.05em;">Or Manual API Key</span>' +
            '<div style="flex:1; height:1px; background:var(--border-subtle);"></div>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">Account ID</label>' +
            '<input type="text" class="form-input" id="acc-id" placeholder="acc_nous_primary">' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">Nous Portal API Key</label>' +
            '<input type="password" class="form-input" id="acc-key" placeholder="sk-nous-...">' +
          '</div>';
      } else if (provider === 'deepseek') {
        container.innerHTML = '' +
          '<div class="form-group">' +
            '<label class="form-label">Account ID</label>' +
            '<input type="text" class="form-input" id="acc-id" placeholder="acc_deepseek_web">' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">DeepSeek userToken Cookie</label>' +
            '<input type="password" class="form-input" id="acc-key" placeholder="userToken=...">' +
          '</div>';
      } else if (provider === 'opencode') {
        container.innerHTML = '' +
          '<div style="background:var(--emerald-bg); border:1px solid var(--emerald-border); border-radius:6px; padding:12px; margin-bottom:12px;">' +
            '<div style="font-weight:600; color:var(--emerald-text); font-size:0.85rem;">Connect OpenCode Zen</div>' +
            '<p style="font-size:0.78rem; color:var(--text-secondary); margin-top:2px;">' +
              'Leave the key blank to connect keyless — anonymous sessions are minted automatically. Paste an OpenCode Zen API key to use your own account instead.' +
            '</p>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">Account ID</label>' +
            '<input type="text" class="form-input" id="acc-id" value="acc_opencode_keyless">' +
          '</div>' +
          '<div class="form-group" style="margin-top:10px;">' +
            '<label class="form-label">API Key (optional)</label>' +
            '<input type="password" class="form-input" id="acc-key" placeholder="Leave blank for keyless">' +
          '</div>' +
          '<button type="button" class="btn btn-emerald btn-sm" style="margin-top:12px;" data-call-click="connectOpenCodeKeyless()">${ICONS.plus} Connect keyless</button>';
      }
    }

    async function submitAccountForm() {
      const idEl = document.getElementById('acc-id');
      const keyEl = document.getElementById('acc-key');

      const isOpenCode = currentProviderTab === 'opencode';
      const key = keyEl?.value.trim() || '';
      const id = idEl?.value.trim() || (isOpenCode ? 'acc_opencode_keyless_' + Date.now() : '');

      if (!id) {
        showToast('Please enter an Account ID', 'error');
        return;
      }

      let payload;
      if (isOpenCode) {
        // Blank key = keyless anonymous account; a key = the user's own account.
        if (key) {
          payload = {
            id, providerId: 'opencode', authType: 'api_key', status: 'active',
            credentials: { apiKey: key },
          };
        } else {
          payload = {
            id, providerId: 'opencode', authType: 'anonymous', status: 'active',
            credentials: {},
          };
        }
      } else {
        if (!key) {
          showToast('Please enter both Account ID and credentials', 'error');
          return;
        }
        payload = {
          id,
          providerId: currentProviderTab,
          authType: currentProviderTab === 'deepseek' ? 'cookie_pool' : (currentProviderTab === 'cline' ? 'oauth' : 'api_key'),
          status: 'active',
          credentials: {
            apiKey: key,
            accessToken: key,
          }
        };
      }

      try {
        const res = await fetch('/api/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (json.success) {
          showToast('Account ' + id + ' registered & hot-reloaded!', 'success');
          closeCredentialsModal();
          fetchAccounts();
        } else {
          showToast('Error registering account: ' + (json.error || 'Server error'), 'error');
        }
      } catch (err) {
        showToast('Network error: ' + err.message, 'error');
      }
    }

    function connectOpenCodeKeyless() {
      const keyEl = document.getElementById('acc-key');
      if (keyEl) keyEl.value = '';
      submitAccountForm();
    }

    async function startOAuthDeviceLogin(provider) {
      const statusEl = document.getElementById('oauth-status-' + provider);
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-secondary);">Requesting device authorization from upstream...</span>';

      try {
        const res = await fetch('/api/oauth/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        });
        const json = await res.json();
        const d = (json && json.data) ? json.data : (json || {});
        const userCode = d.userCode || d.user_code || json.userCode || '';
        const authUrl = d.verificationUriComplete || d.verification_uri_complete || d.authUrl || d.auth_url || d.verificationUri || d.verification_uri || json.authUrl || json.verificationUriComplete || '';
        const sessionId = d.sessionId || d.session_id || json.sessionId || '';

        if (json.success && (userCode || authUrl || sessionId)) {
          if (statusEl) {
            statusEl.innerHTML =
              '<div style="margin-top:6px; padding:10px; background:var(--bg-surface-elevated); border:1px solid var(--border-muted); border-radius:6px;">' +
                '<div style="color:var(--text-secondary); margin-bottom:4px;">1. Verification Code: <strong style="color:var(--emerald-text); letter-spacing:0.1em; font-size:1rem;">' + (userCode || 'CONFIRM') + '</strong></div>' +
                '<div style="margin-bottom:6px;">2. Authorize at: <a href="' + authUrl + '" target="_blank" rel="noopener noreferrer" style="color:var(--emerald-text); text-decoration:underline; word-break:break-all;">' + authUrl + '</a></div>' +
                '<div style="font-size:0.72rem; color:var(--text-tertiary);">Polling authorization status automatically...</div>' +
              '</div>';
          }
          if (authUrl) {
            window.open(authUrl, '_blank');
          }
          if (sessionId) {
            pollOAuthStatus(sessionId, provider);
          }
        } else {
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--coral-text);">Failed: ' + escapeHtml(json.error || 'Upstream error') + '</span>';
        }
      } catch (err) {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--coral-text);">Network error: ' + escapeHtml(err.message) + '</span>';
      }
    }

    function pollOAuthStatus(sessionId, provider) {
      const statusEl = document.getElementById('oauth-status-' + provider);
      const interval = setInterval(async () => {
        try {
          const res = await fetch('/api/oauth/status?sessionId=' + sessionId);
          const json = await res.json();
          if (json.success && json.done) {
            clearInterval(interval);
            if (json.status === 'success') {
              if (statusEl) statusEl.innerHTML = '<span style="color:var(--emerald-text);">Authentication complete for ' + escapeHtml(json.email || 'account') + '!</span>';
              showToast('OAuth account registered live!', 'success');
              fetchAccounts();
            } else {
              if (statusEl) statusEl.textContent = 'Authentication error: ' + json.error;
            }
          }
        } catch {
          clearInterval(interval);
        }
      }, 2500);
    }

    // =========================================================================
    // Virtual Combo Wizard
    // =========================================================================
    let wizardModelFilter = 'all';
    let wizardModelSearchQuery = '';

    function openComboWizard() {
      const modal = document.getElementById('modal-combo-wizard');
      if (modal) {
        modal.classList.add('open');
        modal.classList.add('active');
      }
      wizardCurrentStep = 1;
      wizardTargets = ['kilo/particle-ai/particle-1:free', 'kilo/code-fast:free'];
      wizardModelFilter = 'all';
      wizardModelSearchQuery = '';
      const searchInput = document.getElementById('wizard-model-search');
      if (searchInput) searchInput.value = '';
      updateWizardView();
    }

    function closeComboWizard() {
      const modal = document.getElementById('modal-combo-wizard');
      if (modal) {
        modal.classList.remove('open');
        modal.classList.remove('active');
      }
    }

    function updateWizardView() {
      for (let i = 1; i <= 4; i++) {
        const page = document.getElementById('wizard-page-' + i);
        const node = document.getElementById('wizard-node-' + i);
        if (page) {
          page.classList.toggle('lnl-hidden', i !== wizardCurrentStep);
          page.classList.toggle('lnl-show-block', i === wizardCurrentStep);
        }
        if (node) {
          if (i === wizardCurrentStep) node.classList.add('active');
          else node.classList.remove('active');
        }
      }

      const btnPrev = document.getElementById('wizard-btn-prev');
      const btnNext = document.getElementById('wizard-btn-next');

      if (btnPrev) {
        btnPrev.classList.toggle('lnl-hidden', wizardCurrentStep <= 1);
        btnPrev.classList.toggle('lnl-show-inline-flex', wizardCurrentStep > 1);
      }
      if (btnNext) {
        if (wizardCurrentStep === 1) btnNext.textContent = 'Next: Fallback Chain';
        else if (wizardCurrentStep === 2) btnNext.textContent = 'Next: Policies';
        else if (wizardCurrentStep === 3) btnNext.textContent = 'Next: Review & Deploy';
        else if (wizardCurrentStep === 4) btnNext.textContent = 'Deploy Virtual Combo';
      }

      if (wizardCurrentStep === 2) {
        renderWizardTargets();
        renderWizardModelDirectory();
      }
      if (wizardCurrentStep === 4) generateComboBlueprint();
    }

    function nextWizardStep() {
      if (wizardCurrentStep === 1) {
        const id = document.getElementById('wizard-combo-id')?.value.trim();
        if (!id) {
          showToast('Please enter a Virtual Combo ID', 'error');
          return;
        }
      } else if (wizardCurrentStep === 2) {
        if (wizardTargets.length === 0) {
          showToast('Please add at least one model to the fallback chain', 'error');
          return;
        }
      } else if (wizardCurrentStep === 4) {
        deployCombo();
        return;
      }

      wizardCurrentStep = Math.min(4, wizardCurrentStep + 1);
      updateWizardView();
    }

    function prevWizardStep() {
      wizardCurrentStep = Math.max(1, wizardCurrentStep - 1);
      updateWizardView();
    }

    function renderWizardTargets() {
      const list = document.getElementById('wizard-targets-list');
      const countEl = document.getElementById('wizard-chain-count');
      if (countEl) countEl.textContent = wizardTargets.length;

      if (list) {
        if (wizardTargets.length === 0) {
          list.innerHTML = '<div style="padding:14px; text-align:center; color:var(--text-tertiary); font-size:0.8rem; background:var(--bg-canvas); border:1px dashed var(--border-subtle); border-radius:6px;">No fallback targets configured yet. Select models below to build your zero-drop failover chain.</div>';
        } else {
          list.innerHTML = wizardTargets.map((t, idx) => {
            let providerId = t.includes('/') ? t.split('/')[0] : t;
            if (t.startsWith('cline-free/')) providerId = 'cline';
            const pAccounts = allAccountsData.filter(a => a.providerId === providerId);
            const activeCount = pAccounts.filter(a => a.status === 'active').length;
            const rankLabel = idx === 0 ? 'Primary' : (idx === 1 ? 'Secondary' : 'Fallback #' + idx);

            return '<div style="display:flex; align-items:center; justify-content:space-between; background:var(--bg-surface); border:1px solid var(--border-muted); border-radius:6px; padding:6px 10px;">' +
              '<div style="display:flex; align-items:center; gap:8px; flex:1; min-width:0; margin-right:8px;">' +
                '<span class="badge-tag zinc" style="font-family:var(--font-mono); font-size:0.68rem; font-weight:700;">#' + (idx + 1) + ' ' + rankLabel + '</span>' +
                '<span style="font-family:var(--font-mono); font-size:0.78rem; font-weight:600; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(t) + '</span>' +
                '<span class="badge-tag emerald" style="font-size:0.68rem; padding:1px 6px;">ðŸŸ¢ ' + activeCount + ' acct' + (activeCount === 1 ? '' : 's') + '</span>' +
              '</div>' +
              '<div style="display:flex; align-items:center; gap:4px;">' +
                '<button class="btn btn-secondary btn-sm" data-call-click="moveWizardTarget(' + idx + ', -1)" ' + (idx === 0 ? 'disabled style="opacity:0.25; cursor:not-allowed;"' : '') + ' title="Move Up">â–²</button>' +
                '<button class="btn btn-secondary btn-sm" data-call-click="moveWizardTarget(' + idx + ', 1)" ' + (idx === wizardTargets.length - 1 ? 'disabled style="opacity:0.25; cursor:not-allowed;"' : '') + ' title="Move Down">â–¼</button>' +
                '<button class="btn btn-danger btn-sm" data-call-click="removeWizardTarget(' + idx + ')" title="Remove target" style="padding:4px 8px;">âœ•</button>' +
              '</div>' +
            '</div>';
          }).join('');
        }
      }

      const preview = document.getElementById('wizard-chain-preview');
      if (preview) {
        preview.textContent = wizardTargets.join(' -> ') || '(Empty cascade)';
      }
    }

    function setWizardModelFilter(filter, el) {
      wizardModelFilter = filter;
      document.querySelectorAll('#wizard-model-chips .filter-pill').forEach(btn => btn.classList.remove('active'));
      if (el) el.classList.add('active');
      renderWizardModelDirectory();
    }

    function filterWizardModels() {
      const input = document.getElementById('wizard-model-search');
      wizardModelSearchQuery = (input?.value || '').toLowerCase().trim();
      renderWizardModelDirectory();
    }

    function clearWizardModelSearch() {
      const input = document.getElementById('wizard-model-search');
      if (input) input.value = '';
      wizardModelSearchQuery = '';
      renderWizardModelDirectory();
    }

    function moveWizardTarget(idx, direction) {
      const targetIdx = idx + direction;
      if (targetIdx < 0 || targetIdx >= wizardTargets.length) return;
      const temp = wizardTargets[idx];
      wizardTargets[idx] = wizardTargets[targetIdx];
      wizardTargets[targetIdx] = temp;
      renderWizardTargets();
      renderWizardModelDirectory();
    }

    function toggleTargetInChain(target) {
      const idx = wizardTargets.indexOf(target);
      if (idx >= 0) {
        wizardTargets.splice(idx, 1);
      } else {
        wizardTargets.push(target);
      }
      renderWizardTargets();
      renderWizardModelDirectory();
    }

    function renderWizardModelDirectory() {
      const dirEl = document.getElementById('wizard-model-directory');
      if (!dirEl) return;

      const fallbackCatalog = [
        { id: 'kilo/nvidia/nemotron-3.5-lightning:free', name: 'NVIDIA Nemotron 3.5 Lightning Free (1M Context)', providerId: 'kilo', isFree: true, contextWindow: 1000000, tags: ['free', '1m', 'coding', 'lightning'] },
        { id: 'kilo/particle-ai/particle-1:free', name: 'Particle AI Particle 1 Free (1M Context)', providerId: 'kilo', isFree: true, contextWindow: 1048576, tags: ['free', '1m', 'fast'] },
        { id: 'kilo/baidu/ernie-5.5-flash-preview:free', name: 'Baidu Ernie 5.5 Flash Preview Free (1M Context)', providerId: 'kilo', isFree: true, contextWindow: 1024000, tags: ['free', '1m'] },
        { id: 'kilo/code-fast:free', name: 'Kilo Code Fast Free', providerId: 'kilo', isFree: true, contextWindow: 128000, tags: ['free', 'coding'] },
        { id: 'kilo/kilo-auto/free', name: 'Kilo Auto Free Router', providerId: 'kilo', isFree: true, contextWindow: 128000, tags: ['free', 'auto'] },
        { id: 'cline/sonnet-agent', name: 'Cline Claude 3.5 Sonnet Agent', providerId: 'cline', isFree: false, contextWindow: 200000, tags: ['coding', 'flagship'] },
        { id: 'cline-free/step-5-preview', name: 'Cline Free Step-5 Preview (1M)', providerId: 'cline', isFree: true, contextWindow: 1048576, tags: ['free', '1m'] },
        { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat (V3)', providerId: 'deepseek', isFree: false, contextWindow: 64000, tags: ['coding'] },
        { id: 'nous/hermes-3-llama-3.1-70b', name: 'Nous Hermes 3 Llama 3.1 70B', providerId: 'nous', isFree: false, contextWindow: 128000, tags: ['reasoning', 'hermes'] },
        { id: 'nous/upstage/solar-mini4:free', name: 'Nous Solar Mini 4 Free', providerId: 'nous', isFree: true, contextWindow: 128000, tags: ['free', 'fast'] },
        { id: 'nous/stepfun/step-3.7-flash:free', name: 'Nous Step 3.7 Flash Free', providerId: 'nous', isFree: true, contextWindow: 128000, tags: ['free', 'reasoning'] }
      ];

      const modelsToFilter = (allModels && allModels.length > 0) ? allModels : fallbackCatalog;

      const filtered = modelsToFilter.filter(m => {
        if (wizardModelFilter === 'free' && !m.isFree && !m.id.includes(':free')) return false;
        if (wizardModelFilter === '1m' && (!m.contextWindow || m.contextWindow < 1000000)) return false;
        if (wizardModelFilter === 'coding' && !(m.tags || []).includes('coding') && !m.id.includes('code') && !m.name.toLowerCase().includes('code')) return false;
        if (wizardModelFilter === 'kilo' && m.providerId !== 'kilo') return false;
        if (wizardModelFilter === 'cline' && m.providerId !== 'cline') return false;
        if (wizardModelFilter === 'nous' && m.providerId !== 'nous') return false;
        if (wizardModelFilter === 'deepseek' && m.providerId !== 'deepseek') return false;

        if (wizardModelSearchQuery) {
          const matchName = (m.name || '').toLowerCase().includes(wizardModelSearchQuery);
          const matchId = (m.id || '').toLowerCase().includes(wizardModelSearchQuery);
          const matchProv = (m.providerId || '').toLowerCase().includes(wizardModelSearchQuery);
          const matchTags = (m.tags || []).some(t => t.toLowerCase().includes(wizardModelSearchQuery));
          if (!matchName && !matchId && !matchProv && !matchTags) return false;
        }

        return true;
      });

      const countLabel = document.getElementById('wizard-models-count-label');
      if (countLabel) {
        countLabel.textContent = filtered.length + ' of ' + modelsToFilter.length + ' models available';
      }

      if (filtered.length === 0) {
        dirEl.innerHTML = '<div style="padding:16px; text-align:center; color:var(--text-tertiary); font-size:0.8rem; background:var(--bg-canvas); border:1px dashed var(--border-subtle); border-radius:6px;">No models match search & filter criteria</div>';
        return;
      }

      dirEl.innerHTML = filtered.map(m => {
        const inChain = wizardTargets.includes(m.id);
        const pAccounts = allAccountsData.filter(a => a.providerId === m.providerId);
        const activeAccounts = pAccounts.filter(a => a.status === 'active');
        const depthText = activeAccounts.length > 0 
          ? '<span style="font-size:0.7rem; color:var(--emerald-text); font-weight:600;">ðŸŸ¢ ' + activeAccounts.length + ' active acct' + (activeAccounts.length > 1 ? 's' : '') + '</span>'
          : '<span style="font-size:0.7rem; color:var(--coral-text);">âš ï¸ No active accounts</span>';

        const ctxText = m.contextWindow 
          ? (m.contextWindow >= 1000000 ? Math.round(m.contextWindow / 1000000) + 'M ctx' : Math.round(m.contextWindow / 1000) + 'k ctx')
          : '128k ctx';

        const isFree = m.isFree || m.id.includes(':free');
        const freeBadge = isFree ? '<span class="badge-tag emerald" style="font-size:0.68rem; padding:1px 6px;">Free</span>' : '';
        const provBadge = '<span class="badge-tag zinc" style="font-size:0.68rem; padding:1px 6px; font-family:var(--font-mono);">' + escapeHtml(m.providerId) + '</span>';

        return '<div style="display:flex; align-items:center; justify-content:space-between; background:var(--bg-canvas); border:1px solid ' + (inChain ? 'var(--emerald-border)' : 'var(--border-subtle)') + '; border-radius:6px; padding:7px 10px;">' +
          '<div style="display:flex; flex-direction:column; gap:2px; flex:1; min-width:0; margin-right:8px;">' +
            '<div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">' +
              '<span style="font-size:0.8rem; font-weight:600; color:var(--text-primary);">' + escapeHtml(m.name || m.id) + '</span>' +
              provBadge +
              freeBadge +
              '<span class="badge-tag cyan" style="font-size:0.68rem; padding:1px 6px;">' + ctxText + '</span>' +
            '</div>' +
            '<div style="display:flex; align-items:center; gap:10px; margin-top:1px;">' +
              '<span style="font-family:var(--font-mono); font-size:0.72rem; color:var(--cyan-text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + escapeHtml(m.id) + '</span>' +
              depthText +
            '</div>' +
          '</div>' +
          '<button class="btn ' + (inChain ? 'btn-secondary' : 'btn-primary') + ' btn-sm" data-target="' + escapeHtml(m.id) + '" data-call-click="toggleTargetInChain(this.dataset.target)" style="white-space:nowrap; font-size:0.75rem; padding:4px 10px;">' +
            (inChain ? 'âœ“ Added' : '+ Add') +
          '</button>' +
        '</div>';
      }).join('');
    }

    function addTargetToChain(target) {
      if (!wizardTargets.includes(target)) {
        wizardTargets.push(target);
        renderWizardTargets();
        renderWizardModelDirectory();
      }
    }

    function addCustomTarget() {
      const input = document.getElementById('wizard-custom-target');
      const val = input?.value.trim();
      if (val && !wizardTargets.includes(val)) {
        wizardTargets.push(val);
        input.value = '';
        renderWizardTargets();
        renderWizardModelDirectory();
      }
    }

    function removeWizardTarget(idx) {
      wizardTargets.splice(idx, 1);
      renderWizardTargets();
      renderWizardModelDirectory();
    }

    function generateComboBlueprint() {
      const payload = {
        id: document.getElementById('wizard-combo-id')?.value.trim() || 'lattice/custom-combo',
        name: document.getElementById('wizard-combo-name')?.value.trim() || 'Custom Virtual Combo',
        description: document.getElementById('wizard-combo-desc')?.value.trim() || '',
        targets: wizardTargets,
        strategy: document.getElementById('wizard-combo-strategy')?.value || 'priority',
        useProxies: document.getElementById('wizard-use-proxies')?.checked ?? true,
        timeoutMs: Number(document.getElementById('wizard-timeout')?.value) || 45000,
        retries: Number(document.getElementById('wizard-retries')?.value) || 3,
      };

      const summary = document.getElementById('wizard-summary-json');
      if (summary) summary.value = JSON.stringify(payload, null, 2);
    }

    async function deployCombo() {
      const jsonEl = document.getElementById('wizard-summary-json');
      if (!jsonEl) return;
      const payload = JSON.parse(jsonEl.value);

      const nextBtn = document.getElementById('wizard-btn-next');
      if (nextBtn) {
        nextBtn.disabled = true;
        nextBtn.textContent = 'Deploying...';
      }

      try {
        const res = await fetch('/api/combos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (json.success) {
          showToast('Virtual combo ' + payload.id + ' deployed successfully!', 'success');
          closeComboWizard();
          fetchCombos();
          switchNavTab('combos');
        } else {
          showToast('Failed to deploy combo: ' + (json.error || 'Server error'), 'error');
        }
      } catch (err) {
        showToast('Network error deploying combo: ' + err.message, 'error');
      } finally {
        if (nextBtn) {
          nextBtn.disabled = false;
          nextBtn.textContent = 'Deploy Virtual Combo';
        }
      }
    }

    function onBackdropClick(e, modalId) {
      if (e.target && e.target.id === modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('open');
      }
    }

    // Initialization
    async function refreshBadges() {
      try {
        const [statsRes, harnessRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/harness/status'),
        ]);
        const stats = await statsRes.json().catch(() => ({}));
        const harness = await harnessRes.json().catch(() => ({}));
        const set = (id, value) => {
          const el = document.getElementById(id);
          if (el) el.textContent = value;
        };
        const plugins = stats.metrics?.registeredPlugins ?? 0;
        const activePlugins = stats.metrics?.activePlugins ?? plugins;
        const accounts = stats.metrics?.registeredAccounts ?? 0;
        const activeAccounts = stats.metrics?.activeAccounts ?? accounts;
        const combos = stats.metrics?.activeCombos ?? 0;
        set('badge-plugins-nav', activePlugins + ' Active');
        set('badge-accounts-count', String(accounts));
        set('badge-combos-count', String(combos));
        set('badge-harness-count', (harness.harnesses?.length ?? 0) + ' Tools');
        const modelBadge = document.getElementById('badge-models-count');
        if (modelBadge) modelBadge.textContent = allModels.length ? allModels.length + ' Models' : '--';
        set('kpi-plugins', activePlugins + ' Active');
        set('kpi-accounts', activeAccounts + ' Active');
        set('kpi-combos', combos + ' Active');
        set('plugins-kpi-total', String(plugins));
        set('plugins-kpi-active', String(activePlugins));
        set('plugins-kpi-accounts', String(accounts));
      } catch (err) {
        console.error('refreshBadges error:', err);
      }
    }

    function initDashboard() {
      try {
        window.addEventListener('hashchange', () => {
          const tab = window.location.hash.replace('#', '');
          switchNavTab(tab || 'overview');
        });

        const initialTab = window.location.hash.replace('#', '') || 'overview';
        switchNavTab(initialTab);

        fetchAccounts().catch(() => {});
        fetchCombos().catch(() => {});
        fetchPlugins().catch(() => {});
        fetchModels().catch(() => {});
        fetchHarnesses().catch(() => {});
        refreshBadges().catch(() => {});
        fetchTelemetry().catch(() => {});
        fetchUsageStats().catch(() => {});
        fetchQuotas().catch(() => {});
        initLogStream();
        switchProviderTab('cline');
        renderWizardTargets();
      } catch (err) {
        console.error('Initialization error in Mission Control:', err);
      } finally {
        // Guarantee at least one tab view is active and visible
        if (!document.querySelector('.tab-view.active')) {
          const fallback = document.getElementById('view-overview');
          if (fallback) fallback.classList.add('active');
        }
      }

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeCredentialsModal();
          closeComboWizard();
          closeRequestDetailModal();
        }
      });

      // Global Event Delegation for all interactive UI triggers
      document.addEventListener('click', (e) => {
        // Navigation tabs
        const navItem = e.target.closest('.nav-item');
        if (navItem && navItem.getAttribute('data-tab')) {
          switchNavTab(navItem.getAttribute('data-tab'));
          return;
        }

        // Action elements
        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;
        const action = actionEl.getAttribute('data-action');
        const id = actionEl.getAttribute('data-id');
        const provider = actionEl.getAttribute('data-provider');

        switch (action) {
          case 'setup-harness':
            if (id) setupSingleHarness(id);
            break;
          case 'setup-all-harnesses':
            setupAllHarnesses();
            break;
          case 'probe-model':
            if (id) probeModelLive(id);
            break;
          case 'copy-model-id':
            if (id) copyToClipboard(id, 'Copied model ID!');
            break;
          case 'toggle-snippet':
            if (id) toggleSnippetBox(id);
            break;
          case 'copy-snippet-code':
            if (id) copySnippetRaw(id);
            break;
          case 'test-account':
            if (id) testAccount(id);
            break;
          case 'delete-account':
            if (id) deleteAccount(id);
            break;
          case 'delete-combo':
            if (id) deleteCombo(id);
            break;
          case 'toggle-plugin':
            if (id) togglePlugin(id);
            break;
          case 'toggle-accordion':
            if (id) toggleProviderAccordion(id);
            break;
          case 'reset-quota':
            if (id) resetQuotaCooldown(id);
            break;
          case 'start-oauth':
            if (provider) startOAuthDeviceLogin(provider);
            break;
          case 'open-credentials':
            openCredentialsModal(provider);
            break;
          case 'close-credentials':
            closeCredentialsModal();
            break;
          case 'open-combo-wizard':
            openComboWizard();
            break;
          case 'close-combo-wizard':
            closeComboWizard();
            break;
          case 'sync-local':
            syncLocalAccounts();
            break;
        }
      });

      // Expose globally for inline DOM handlers
      window.switchNavTab = switchNavTab;
      window.openCredentialsModal = openCredentialsModal;
      window.closeCredentialsModal = closeCredentialsModal;
      window.openComboWizard = openComboWizard;
      window.closeComboWizard = closeComboWizard;
      window.triggerSimulatedPing = triggerSimulatedPing;
      window.clearLogs = clearLogs;
      window.switchProviderTab = switchProviderTab;
      window.submitAccountForm = submitAccountForm;
      window.connectOpenCodeKeyless = connectOpenCodeKeyless;
      window.startOAuthDeviceLogin = startOAuthDeviceLogin;
      window.syncLocalAccounts = syncLocalAccounts;
      window.nextWizardStep = nextWizardStep;
      window.prevWizardStep = prevWizardStep;
      window.addTargetToChain = addTargetToChain;
      window.addCustomTarget = addCustomTarget;
      window.removeWizardTarget = removeWizardTarget;
      window.moveWizardTarget = moveWizardTarget;
      window.toggleTargetInChain = toggleTargetInChain;
      window.setWizardModelFilter = setWizardModelFilter;
      window.filterWizardModels = filterWizardModels;
      window.clearWizardModelSearch = clearWizardModelSearch;
      window.renderWizardModelDirectory = renderWizardModelDirectory;
      window.onBackdropClick = onBackdropClick;
      window.fetchAccounts = fetchAccounts;
      window.fetchCombos = fetchCombos;
      window.fetchPlugins = fetchPlugins;
      window.fetchModels = fetchModels;
      window.filterModels = filterModels;
      window.setModelsFilter = setModelsFilter;
      window.probeModelLive = probeModelLive;
      window.refreshBadges = refreshBadges;
      window.fetchHarnesses = fetchHarnesses;
      window.refreshHarnessStatus = refreshHarnessStatus;
      window.setupSingleHarness = setupSingleHarness;
      window.setupAllHarnesses = setupAllHarnesses;
      window.toggleSnippetBox = toggleSnippetBox;
      window.copySnippetRaw = copySnippetRaw;
      window.copyToClipboard = copyToClipboard;
      window.testAccount = testAccount;
      window.deleteAccount = deleteAccount;
      window.deleteCombo = deleteCombo;
      window.togglePlugin = togglePlugin;
      window.fetchUsageStats = fetchUsageStats;
      window.setUsagePeriod = setUsagePeriod;
      window.toggleUsageMode = toggleUsageMode;
      window.toggleProviderAccordion = toggleProviderAccordion;
      window.renderUsageView = renderUsageView;
      window.showRequestDetailModal = showRequestDetailModal;
      window.closeRequestDetailModal = closeRequestDetailModal;
      window.fetchQuotas = fetchQuotas;
      window.filterQuotas = filterQuotas;
      window.resetQuotaCooldown = resetQuotaCooldown;
      window.renderQuotasView = renderQuotasView;
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initDashboard);
    } else {
      initDashboard();
    }
  </script>
</body>
</html>`;
}

