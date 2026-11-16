import { ICONS } from './icons';

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lattice Gateway — Mission Control</title>
  <style>
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

    .modal-backdrop.open {
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
      <a class="nav-item active" data-tab="overview" onclick="switchNavTab('overview')">
        ${ICONS.activity}
        <span>Overview &amp; KPIs</span>
      </a>
      <a class="nav-item" data-tab="models" onclick="switchNavTab('models')">
        ${ICONS.cpu}
        <span>Free Models</span>
        <span class="nav-badge emerald" id="badge-models-count">31 Free</span>
      </a>
      <a class="nav-item" data-tab="harnesses" onclick="switchNavTab('harnesses')">
        ${ICONS.terminal}
        <span>Harness Setup</span>
        <span class="nav-badge" id="badge-harness-count">7 Tools</span>
      </a>
      <a class="nav-item" data-tab="telemetry" onclick="switchNavTab('telemetry')">
        ${ICONS.activity}
        <span>Token Telemetry</span>
      </a>

      <div class="nav-section-title" style="margin-top: 6px;">Control Plane</div>
      <a class="nav-item" data-tab="accounts" onclick="switchNavTab('accounts')">
        ${ICONS.key}
        <span>Credential Pools</span>
        <span class="nav-badge" id="badge-accounts-count">8</span>
      </a>
      <a class="nav-item" data-tab="combos" onclick="switchNavTab('combos')">
        ${ICONS.gitBranch}
        <span>Virtual Combos</span>
        <span class="nav-badge" id="badge-combos-count">2</span>
      </a>
      <a class="nav-item" data-tab="plugins" onclick="switchNavTab('plugins')">
        ${ICONS.layers}
        <span>Provider Plugins</span>
        <span class="nav-badge" id="badge-plugins-count">6</span>
      </a>
      <a class="nav-item" data-tab="logs" onclick="switchNavTab('logs')">
        ${ICONS.radio}
        <span>Live Ingress Stream</span>
        <span class="status-dot emerald pulse" style="margin-left:auto;"></span>
      </a>
    </nav>

    <div class="sidebar-footer">
      <button class="btn btn-primary" onclick="openCredentialsModal()">
        ${ICONS.plus}
        <span>Add Credentials</span>
      </button>
      <button class="btn btn-secondary" onclick="openComboWizard()">
        ${ICONS.sparkles}
        <span>Combo Wizard</span>
      </button>
      <button class="btn btn-emerald btn-sm" onclick="triggerSimulatedPing()">
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
          <button class="btn btn-secondary btn-sm" onclick="switchNavTab('models')">
            ${ICONS.cpu}
            <span>Explore Free Models</span>
          </button>
          <button class="btn btn-primary btn-sm" onclick="switchNavTab('harnesses')">
            ${ICONS.terminal}
            <span>1-Click Harness Setup</span>
          </button>
        </div>
      </div>

      <!-- KPI Grid -->
      <div class="kpi-grid">
        <div class="kpi-card" onclick="switchNavTab('plugins')" style="cursor:pointer;" title="View Provider Plugins">
          <div class="kpi-label">Active Plugins</div>
          <div class="kpi-value" id="kpi-plugins" style="color: var(--text-primary);">6 Active</div>
          <div class="kpi-subtext">Kilo · Nous · Cline · OpenCode · DeepSeek · Lattice</div>
        </div>
        <div class="kpi-card" onclick="switchNavTab('accounts')" style="cursor:pointer;" title="View Credential Pools">
          <div class="kpi-label">Active Accounts</div>
          <div class="kpi-value" id="kpi-accounts" style="color: var(--emerald-text);">8 Active</div>
          <div class="kpi-subtext" id="kpi-accounts-sub">0 in rate cooldown</div>
        </div>
        <div class="kpi-card" onclick="switchNavTab('models')" style="cursor:pointer;" title="View Free Models">
          <div class="kpi-label">Free Models</div>
          <div class="kpi-value" id="kpi-models" style="color: var(--cyan-text);">31 Free</div>
          <div class="kpi-subtext">6 with 1M context</div>
        </div>
        <div class="kpi-card" onclick="switchNavTab('combos')" style="cursor:pointer;" title="View Virtual Combos">
          <div class="kpi-label">Virtual Combos</div>
          <div class="kpi-value" id="kpi-combos" style="color: var(--text-primary);">2 Active</div>
          <div class="kpi-subtext">Auto-failover active</div>
        </div>
        <div class="kpi-card" onclick="switchNavTab('telemetry')" style="cursor:pointer;" title="View Telemetry">
          <div class="kpi-label">Average Latency</div>
          <div class="kpi-value" id="kpi-latency" style="color: var(--amber-text);">~118ms</div>
          <div class="kpi-subtext">Rolling avg across upstreams</div>
        </div>
        <div class="kpi-card" onclick="switchNavTab('telemetry')" style="cursor:pointer;" title="View Telemetry">
          <div class="kpi-label">Streamed Tokens</div>
          <div class="kpi-value" id="kpi-tokens" style="color: var(--text-primary);">813,700</div>
          <div class="kpi-subtext" id="kpi-tokens-sub">524k in · 289k out</div>
        </div>
        <div class="kpi-card" onclick="switchNavTab('telemetry')" style="cursor:pointer;" title="View Telemetry">
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
              <div class="hub-desc">31 zero-cost frontier models across 6 upstreams</div>
            </div>
          </div>
          <div class="hub-content">
            Includes 6 million-token models (Particle 1, Ernie 5.5, Nemotron Lightning, Ling 3.2, Step-5 Preview, and Lattice 1M combo) with instant 1-token test probes.
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-primary btn-sm" onclick="switchNavTab('models')">
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
            <button class="btn btn-secondary btn-sm" onclick="switchNavTab('harnesses')">
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
            Autonomous health check probing, WorkOS OAuth device flow, and 1-click local sync from 9router and Cline Proxy data stores.
          </div>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary btn-sm" onclick="switchNavTab('accounts')">Manage Accounts</button>
            <button class="btn btn-primary btn-sm" onclick="openCredentialsModal()">Add Key</button>
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
            <button class="btn btn-secondary btn-sm" onclick="switchNavTab('combos')">Configure Combos</button>
            <button class="btn btn-primary btn-sm" onclick="openComboWizard()">Combo Wizard</button>
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
          <p>Searchable directory of 31 verified zero-cost models across Kilo, Cline, DeepSeek, OpenCode Zen, Nous &amp; Combos</p>
        </div>
        <div class="header-actions">
          <div class="status-pill emerald">
            <span class="status-dot emerald"></span>
            <span id="models-free-counter">31 Models Available ($0)</span>
          </div>
        </div>
      </div>

      <!-- Filter and Search Bar -->
      <div class="filter-bar">
        <div class="search-box">
          ${ICONS.search}
          <input type="text" class="search-input" id="models-search" placeholder="Search models by name, ID, provider, capability, or tags..." oninput="filterModels()">
        </div>
        <div class="filter-pills">
          <button class="filter-btn active" data-filter="all" onclick="setModelsFilter('all', this)">All (31)</button>
          <button class="filter-btn" data-filter="1m" onclick="setModelsFilter('1m', this)">1M Context (6)</button>
          <button class="filter-btn" data-filter="reasoning" onclick="setModelsFilter('reasoning', this)">Reasoning</button>
          <button class="filter-btn" data-filter="coding" onclick="setModelsFilter('coding', this)">Coding</button>
          <button class="filter-btn" data-filter="fast" onclick="setModelsFilter('fast', this)">Fast</button>
          <button class="filter-btn" data-filter="keyless" onclick="setModelsFilter('keyless', this)">Keyless Zen</button>
        </div>
        <select class="form-select" id="models-provider-filter" style="width: auto; padding: 5px 10px;" onchange="filterModels()">
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
          <button class="btn btn-secondary btn-sm" onclick="refreshHarnessStatus()">
            ${ICONS.refresh}
            <span>Re-scan Status</span>
          </button>
          <button class="btn btn-primary btn-sm" onclick="setupAllHarnesses()">
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
          <button class="btn btn-emerald btn-sm" onclick="triggerSimulatedPing()">
            ${ICONS.play}
            <span>Simulate Telemetry Ping</span>
          </button>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">Total Cumulative Tokens</div>
          <div class="kpi-value" id="telem-total" style="color: var(--text-primary);">813,700</div>
          <div class="kpi-subtext">Processed across all upstreams</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Prompt Tokens</div>
          <div class="kpi-value" id="telem-prompt" style="color: var(--cyan-text);">524,300</div>
          <div class="kpi-subtext">64.4% of total volume</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Completion Tokens</div>
          <div class="kpi-value" id="telem-completion" style="color: var(--emerald-text);">289,400</div>
          <div class="kpi-subtext">35.6% generated output</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Total Ingress Requests</div>
          <div class="kpi-value" id="telem-requests" style="color: var(--text-primary);">462</div>
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
    <!-- VIEW 5: Credential Pools                                            -->
    <!-- =================================================================== -->
    <div class="tab-view" id="view-accounts">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Credential Pools &amp; Upstream Accounts</h1>
          <p>Multi-account token pools with auto-rotation, rate-limit cooldown, and live health probing</p>
        </div>
        <div class="header-actions">
          <button class="btn btn-secondary btn-sm" onclick="syncLocalAccounts()">
            ${ICONS.refresh}
            <span>Auto-Sync 9router &amp; Cline Stores</span>
          </button>
          <button class="btn btn-primary btn-sm" onclick="openCredentialsModal()">
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
          <button class="btn btn-primary btn-sm" onclick="openComboWizard()">
            ${ICONS.plus}
            <span>Create Virtual Combo</span>
          </button>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Combo ID</th>
              <th>Name</th>
              <th>Target Cascade Chain</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="combos-table-body">
            <!-- Rendered dynamically -->
          </tbody>
        </table>
      </div>
    </div>

    <!-- =================================================================== -->
    <!-- VIEW 7: Provider Plugins                                            -->
    <!-- =================================================================== -->
    <div class="tab-view" id="view-plugins">
      <div class="view-header">
        <div class="view-title-group">
          <h1>Provider Plugins &amp; Upstreams</h1>
          <p>Upstream adapters managing protocol translations, authentication, and endpoint dispatch</p>
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Plugin ID</th>
              <th>Display Name</th>
              <th>Default Base URL</th>
              <th>Supported Auth</th>
              <th>State</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="plugins-table-body">
            <!-- Rendered dynamically -->
          </tbody>
        </table>
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
          <button class="btn btn-secondary btn-sm" onclick="clearLogs()">
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
  <div class="modal-backdrop" id="modal-credentials" onclick="onBackdropClick(event, 'modal-credentials')">
    <div class="modal-window">
      <div class="modal-header">
        <div class="modal-title">Register Upstream Provider Credentials</div>
        <button class="modal-close" onclick="closeCredentialsModal()">${ICONS.x}</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">Select Upstream Provider</label>
          <div class="provider-tabs">
            <div class="provider-tab-btn active" id="tab-btn-cline" onclick="switchProviderTab('cline')">
              <span class="provider-tab-name">Cline Pool</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-kilo" onclick="switchProviderTab('kilo')">
              <span class="provider-tab-name">Kilo Code</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-nous" onclick="switchProviderTab('nous')">
              <span class="provider-tab-name">Nous Research</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-deepseek" onclick="switchProviderTab('deepseek')">
              <span class="provider-tab-name">DeepSeek</span>
            </div>
            <div class="provider-tab-btn" id="tab-btn-opencode" onclick="switchProviderTab('opencode')">
              <span class="provider-tab-name">OpenCode Zen</span>
            </div>
          </div>
        </div>

        <div id="provider-fields-container"></div>
      </div>
      <div class="modal-footer" id="modal-credentials-footer">
        <button class="btn btn-secondary" onclick="closeCredentialsModal()">Cancel</button>
        <button class="btn btn-primary" id="btn-save-account" onclick="submitAccountForm()">Save &amp; Connect Account</button>
      </div>
    </div>
  </div>

  <!-- ===================================================================== -->
  <!-- MODAL 2: Virtual Combo Creator Wizard (Preserving test invariants)    -->
  <!-- ===================================================================== -->
  <div class="modal-backdrop" id="modal-combo-wizard" onclick="onBackdropClick(event, 'modal-combo-wizard')">
    <div class="modal-window">
      <div class="modal-header">
        <div>
          <div class="modal-title">Virtual Model Combo Creator Wizard</div>
          <p style="font-size:0.75rem; color:var(--text-tertiary); margin-top:2px;">
            Configure zero-drop cascade failover across multiple providers
          </p>
        </div>
        <button class="modal-close" onclick="closeComboWizard()">${ICONS.x}</button>
      </div>

      <div class="modal-body">
        <div class="wizard-steps-indicator">
          <div class="wizard-step-node active" id="wizard-node-1">
            <div class="wizard-step-circle">1</div>
            <span>Identity</span>
          </div>
          <div class="wizard-step-node" id="wizard-node-2">
            <div class="wizard-step-circle">2</div>
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
          <label class="form-label">Configured Fallback Target Chain</label>
          <div id="wizard-targets-list" style="display:flex; flex-direction:column; gap:6px; margin-top:6px;"></div>

          <div style="margin-top:12px;">
            <label class="form-label">Quick Add Model to Chain</label>
            <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">
              <button class="btn btn-secondary btn-sm" onclick="addTargetToChain('kilo/particle-ai/particle-1:free')">+ Particle 1 (1M)</button>
              <button class="btn btn-secondary btn-sm" onclick="addTargetToChain('kilo/kilo-auto/free')">+ Kilo Auto Free</button>
              <button class="btn btn-secondary btn-sm" onclick="addTargetToChain('deepseek/deepseek-chat')">+ DeepSeek Chat</button>
              <button class="btn btn-secondary btn-sm" onclick="addTargetToChain('big-pickle')">+ Big Pickle (Zen)</button>
              <button class="btn btn-secondary btn-sm" onclick="addTargetToChain('cline-free/step-5-preview')">+ Step-5 (1M)</button>
            </div>
            <div style="display:flex; gap:8px; margin-top:10px;">
              <input type="text" class="form-input" id="wizard-custom-target" placeholder="provider/model-id" style="flex:1;">
              <button class="btn btn-secondary" onclick="addCustomTarget()">Add Custom</button>
            </div>
          </div>

          <div style="margin-top:14px; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:6px; padding:10px;">
            <div style="font-size:0.7rem; color:var(--text-tertiary); font-family:var(--font-mono); text-transform:uppercase;">Chain Preview</div>
            <div id="wizard-chain-preview" style="font-family:var(--font-mono); font-size:0.78rem; color:var(--cyan-text); margin-top:4px;"></div>
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
        <button class="btn btn-secondary" id="wizard-btn-prev" onclick="prevWizardStep()" style="display:none;">Back</button>
        <button class="btn btn-primary" id="wizard-btn-next" onclick="nextWizardStep()">Next: Fallback Chain</button>
      </div>
    </div>
  </div>

  <!-- Client-Side Vanilla SPA Script Engine -->
  <script>
    let currentTab = 'overview';
    let currentProviderTab = 'cline';
    let wizardCurrentStep = 1;
    let wizardTargets = [];
    let allModels = [];
    let activeFilter = 'all';
    let allHarnesses = [];

    // Toast feedback system
    function showToast(message, type = 'info') {
      const container = document.getElementById('toast-container');
      if (!container) return;
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        setTimeout(() => toast.remove(), 200);
      }, 3500);
    }

    // Tab Navigation
    function switchNavTab(tabId) {
      currentTab = tabId;
      document.querySelectorAll('.tab-view').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

      const targetView = document.getElementById('view-' + tabId);
      if (targetView) targetView.classList.add('active');

      const targetNav = document.querySelector('.nav-item[data-tab="' + tabId + '"]');
      if (targetNav) targetNav.classList.add('active');

      if (window.location.hash !== '#' + tabId) {
        history.replaceState(null, '', '#' + tabId);
      }

      if (tabId === 'models' && allModels.length === 0) fetchModels();
      if (tabId === 'harnesses' && allHarnesses.length === 0) fetchHarnesses();
      if (tabId === 'telemetry') fetchTelemetry();
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
          allModels = json.models;
          renderModelsGrid(allModels);
          const counter = document.getElementById('models-free-counter');
          if (counter) counter.textContent = allModels.length + ' Models Available ($0)';
          const kpi = document.getElementById('kpi-models');
          if (kpi) kpi.textContent = allModels.length + ' Free';
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
          '<span class="badge-tag ' + b.color + '">' + b.text + '</span>'
        ).join('');

        return '' +
          '<div class="model-card" id="card-model-' + m.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '">' +
            '<div class="model-card-header">' +
              '<div>' +
                '<div class="model-card-title">' + (m.name || m.id) + '</div>' +
                '<div class="model-card-provider">' + m.providerId + ' · ' + m.ownedBy + '</div>' +
              '</div>' +
              '<div class="model-badges">' + badgesHtml + '</div>' +
            '</div>' +
            (m.description ? '<p style="font-size:0.78rem; color:var(--text-secondary);">' + m.description + '</p>' : '') +
            '<div class="model-id-box">' +
              '<span>' + m.id + '</span>' +
              '<button class="copy-btn" onclick="copyToClipboard(\\'' + m.id + '\\', \\'Copied model ID \\\\'' + m.id + '\\\\\\'!\\')" title="Copy Model ID">' +
                '${ICONS.copy}' +
              '</button>' +
            '</div>' +
            '<div class="model-specs">' +
              '<span>Context: <strong>' + m.contextWindowFormatted + '</strong></span>' +
              '<div class="model-probe-status" id="probe-status-' + m.id.replace(/[^a-zA-Z0-9_-]/g, '_') + '">' +
                '<button class="btn btn-secondary btn-sm" onclick="probeModelLive(\\'' + m.id + '\\')">' +
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
            statusEl.innerHTML = '<span class="status-pill emerald"><span class="status-dot emerald"></span> ' + data.latencyMs + 'ms · 200 OK</span>';
          }
          showToast('Probe OK (' + data.latencyMs + 'ms) for ' + modelId, 'success');
        } else {
          if (statusEl) {
            statusEl.innerHTML = '<span class="status-pill coral"><span class="status-dot coral"></span> ' + (data.error || 'Failed') + '</span>';
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
                  '<div class="harness-name">' + h.name + '</div>' +
                  '<div class="harness-category">' + h.category + ' · ' + h.protocol.toUpperCase() + '</div>' +
                '</div>' +
              '</div>' +
              statusBadge +
            '</div>' +
            '<div class="harness-desc">' + h.description + '</div>' +
            '<div class="harness-path-box" title="' + h.targetPath + '">' + h.targetPath + '</div>' +
            '<div class="harness-actions">' +
              '<button class="btn btn-primary btn-sm" id="btn-setup-' + safeId + '" onclick="setupSingleHarness(\\'' + h.id + '\\')">' +
                '${ICONS.zap}' +
                '<span>1-Click Setup</span>' +
              '</button>' +
              '<button class="btn btn-secondary btn-sm" onclick="toggleSnippetBox(\\'' + safeId + '\\')">' +
                '${ICONS.code}' +
                '<span>View Snippet</span>' +
              '</button>' +
              '<button class="btn btn-secondary btn-sm" onclick="copyToClipboard(\\'' + encodeURIComponent(h.configSnippet) + '\\', \\'Copied snippet!\\', true)" title="Copy configuration snippet">' +
                '${ICONS.copy}' +
              '</button>' +
            '</div>' +
            '<div class="snippet-box" id="snippet-box-' + safeId + '" style="display:none;">' +
              '<button class="btn btn-secondary btn-sm snippet-copy" onclick="copySnippetRaw(\\'' + safeId + '\\')">' +
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
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
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
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // =========================================================================
    // Core REST API Calls: Accounts, Combos, Plugins, Telemetry
    // =========================================================================
    async function fetchAccounts() {
      try {
        const res = await fetch('/api/accounts');
        const json = await res.json();
        if (json.success && Array.isArray(json.accounts)) {
          const tbody = document.getElementById('accounts-table-body');
          if (tbody) {
            tbody.innerHTML = json.accounts.map(a => 
              '<tr>' +
                '<td style="font-family:var(--font-mono); font-weight:600; color:var(--text-primary);">' + a.id + '</td>' +
                '<td>' + a.providerId + '</td>' +
                '<td><span class="badge-tag zinc">' + a.authType + '</span></td>' +
                '<td><span class="status-pill ' + (a.status === 'active' ? 'emerald' : 'amber') + '">' + a.status + '</span></td>' +
                '<td>' + (a.errorCount || 0) + '</td>' +
                '<td style="font-family:var(--font-mono); font-size:0.75rem;">' + (a.credentials.email || a.credentials.apiKey || a.credentials.accessToken || 'configured') + '</td>' +
                '<td>' +
                  '<div style="display:flex; gap:6px;">' +
                    '<button class="btn btn-secondary btn-sm" onclick="testAccount(\\'' + a.id + '\\')">Test</button>' +
                    '<button class="btn btn-danger btn-sm" onclick="deleteAccount(\\'' + a.id + '\\')">Delete</button>' +
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
      showToast('Scanning 9router and Cline Proxy stores on disk...', 'info');
      try {
        const res = await fetch('/api/accounts/sync-local', { method: 'POST' });
        const json = await res.json();
        if (json.success) {
          showToast(json.message, 'success');
          fetchAccounts();
        }
      } catch (err) {
        showToast('Local sync error: ' + err.message, 'error');
      }
    }

    async function fetchCombos() {
      try {
        const res = await fetch('/api/combos');
        const json = await res.json();
        if (json.success && Array.isArray(json.combos)) {
          const tbody = document.getElementById('combos-table-body');
          if (tbody) {
            tbody.innerHTML = json.combos.map(c => 
              '<tr>' +
                '<td style="font-family:var(--font-mono); font-weight:600; color:var(--cyan-text);">' + c.id + '</td>' +
                '<td>' + (c.name || c.id) + '</td>' +
                '<td><div style="display:flex; flex-wrap:wrap; gap:4px;">' +
                  (c.targets || []).map(t => '<span class="badge-tag zinc">' + t + '</span>').join('') +
                '</div></td>' +
                '<td>' +
                  '<button class="btn btn-danger btn-sm" onclick="deleteCombo(\\'' + encodeURIComponent(c.id) + '\\')">Delete</button>' +
                '</td>' +
              '</tr>'
            ).join('');
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
          if (tbody) {
            tbody.innerHTML = json.plugins.map(p => 
              '<tr>' +
                '<td style="font-family:var(--font-mono); font-weight:600;">' + p.id + '</td>' +
                '<td>' + p.displayName + '</td>' +
                '<td style="font-family:var(--font-mono); font-size:0.75rem;">' + p.defaultBaseUrl + '</td>' +
                '<td>' + (p.supportedAuthTypes || []).join(', ') + '</td>' +
                '<td><span class="status-pill ' + (p.enabled ? 'emerald' : 'zinc') + '">' + (p.enabled ? 'Enabled' : 'Disabled') + '</span></td>' +
                '<td>' +
                  '<button class="btn btn-secondary btn-sm" onclick="togglePlugin(\\'' + p.id + '\\')">' +
                    (p.enabled ? 'Disable' : 'Enable') +
                  '</button>' +
                '</td>' +
              '</tr>'
            ).join('');
          }
          const badge = document.getElementById('badge-plugins-count');
          if (badge) badge.textContent = json.plugins.filter(p => p.enabled).length;
          const kpi = document.getElementById('kpi-plugins');
          if (kpi) kpi.textContent = json.plugins.filter(p => p.enabled).length + ' Active';
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
                '<td style="color:var(--emerald-text); font-family:var(--font-mono); font-weight:600;">$' + ((data.total || 0) * 0.000026).toFixed(2) + '</td>' +
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
              '<span class="log-time">' + new Date(log.timestamp).toLocaleTimeString() + '</span>' +
              '<span class="log-method">' + log.method + '</span>' +
              '<span class="log-path">' + log.path + '</span>' +
              '<span class="badge-tag zinc">' + log.model + '</span>' +
              '<span class="log-meta">' +
                '<span class="status-pill ' + (log.status === 200 ? 'emerald' : 'coral') + '">' + log.status + '</span>' +
                '<span>' + log.latencyMs + 'ms</span>' +
                '<span style="color:var(--cyan-text);">' + (log.totalTokens || 0) + ' tok</span>' +
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
    function openCredentialsModal() {
      const modal = document.getElementById('modal-credentials');
      if (modal) modal.classList.add('open');
      switchProviderTab(currentProviderTab);
    }

    function closeCredentialsModal() {
      const modal = document.getElementById('modal-credentials');
      if (modal) modal.classList.remove('open');
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
            '<button type="button" class="btn btn-emerald btn-sm" onclick="startOAuthDeviceLogin(\\'kilo\\')">Start OAuth Device Login</button>' +
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
            '<button type="button" class="btn btn-emerald btn-sm" onclick="startOAuthDeviceLogin(\\'cline\\')">Start OAuth Device Login</button>' +
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
            '<button type="button" class="btn btn-emerald btn-sm" onclick="startOAuthDeviceLogin(\\'nous\\')">Start OAuth Device Login</button>' +
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
          '<div style="background:var(--emerald-bg); border:1px solid var(--emerald-border); border-radius:6px; padding:12px;">' +
            '<div style="font-weight:600; color:var(--emerald-text); font-size:0.85rem;">Zero-Auth Keyless Mode Active</div>' +
            '<p style="font-size:0.78rem; color:var(--text-secondary); margin-top:2px;">' +
              'OpenCode Zen models operate anonymously with automatic session minting and 12 gate tools. No manual API keys required.' +
            '</p>' +
          '</div>';
      }
    }

    async function submitAccountForm() {
      const idEl = document.getElementById('acc-id');
      const keyEl = document.getElementById('acc-key');

      if (currentProviderTab === 'opencode') {
        showToast('OpenCode Zen operates keyless and is already registered live!', 'info');
        closeCredentialsModal();
        return;
      }

      const id = idEl?.value.trim();
      const key = keyEl?.value.trim();

      if (!id || !key) {
        showToast('Please enter both Account ID and credentials', 'error');
        return;
      }

      const payload = {
        id,
        providerId: currentProviderTab,
        authType: currentProviderTab === 'deepseek' ? 'cookie_pool' : (currentProviderTab === 'cline' ? 'oauth' : 'api_key'),
        status: 'active',
        credentials: {
          apiKey: key,
          accessToken: key,
        }
      };

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
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--coral-text);">Failed: ' + (json.error || 'Upstream error') + '</span>';
        }
      } catch (err) {
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--coral-text);">Network error: ' + err.message + '</span>';
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
              if (statusEl) statusEl.innerHTML = '<span style="color:var(--emerald-text);">Authentication complete for ' + (json.email || 'account') + '!</span>';
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
    function openComboWizard() {
      const modal = document.getElementById('modal-combo-wizard');
      if (modal) modal.classList.add('open');
      wizardCurrentStep = 1;
      wizardTargets = ['kilo/particle-ai/particle-1:free', 'kilo/code-fast:free'];
      updateWizardView();
    }

    function closeComboWizard() {
      const modal = document.getElementById('modal-combo-wizard');
      if (modal) modal.classList.remove('open');
    }

    function updateWizardView() {
      for (let i = 1; i <= 4; i++) {
        const page = document.getElementById('wizard-page-' + i);
        const node = document.getElementById('wizard-node-' + i);
        if (page) page.style.display = i === wizardCurrentStep ? 'block' : 'none';
        if (node) {
          if (i === wizardCurrentStep) node.classList.add('active');
          else node.classList.remove('active');
        }
      }

      const btnPrev = document.getElementById('wizard-btn-prev');
      const btnNext = document.getElementById('wizard-btn-next');

      if (btnPrev) btnPrev.style.display = wizardCurrentStep > 1 ? 'inline-flex' : 'none';
      if (btnNext) {
        if (wizardCurrentStep === 1) btnNext.textContent = 'Next: Fallback Chain';
        else if (wizardCurrentStep === 2) btnNext.textContent = 'Next: Policies';
        else if (wizardCurrentStep === 3) btnNext.textContent = 'Next: Review & Deploy';
        else if (wizardCurrentStep === 4) btnNext.textContent = 'Deploy Virtual Combo';
      }

      if (wizardCurrentStep === 2) renderWizardTargets();
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
      if (list) {
        list.innerHTML = wizardTargets.map((t, idx) => 
          '<div style="display:flex; align-items:center; justify-content:space-between; background:var(--bg-canvas); border:1px solid var(--border-subtle); border-radius:6px; padding:6px 10px;">' +
            '<span style="font-family:var(--font-mono); font-size:0.78rem;">' + (idx + 1) + '. ' + t + '</span>' +
            '<button class="btn btn-secondary btn-sm" onclick="removeWizardTarget(' + idx + ')">${ICONS.x}</button>' +
          '</div>'
        ).join('');
      }

      const preview = document.getElementById('wizard-chain-preview');
      if (preview) {
        preview.textContent = wizardTargets.join(' -> ') || '(Empty cascade)';
      }
    }

    function addTargetToChain(target) {
      if (!wizardTargets.includes(target)) {
        wizardTargets.push(target);
        renderWizardTargets();
      }
    }

    function addCustomTarget() {
      const input = document.getElementById('wizard-custom-target');
      const val = input?.value.trim();
      if (val && !wizardTargets.includes(val)) {
        wizardTargets.push(val);
        input.value = '';
        renderWizardTargets();
      }
    }

    function removeWizardTarget(idx) {
      wizardTargets.splice(idx, 1);
      renderWizardTargets();
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
    function initDashboard() {
      window.addEventListener('hashchange', () => {
        const tab = window.location.hash.replace('#', '');
        if (tab && document.getElementById('view-' + tab)) {
          switchNavTab(tab);
        }
      });

      const initialTab = window.location.hash.replace('#', '') || 'overview';
      switchNavTab(document.getElementById('view-' + initialTab) ? initialTab : 'overview');

      fetchAccounts().catch(() => {});
      fetchCombos().catch(() => {});
      fetchPlugins().catch(() => {});
      fetchModels().catch(() => {});
      fetchHarnesses().catch(() => {});
      fetchTelemetry().catch(() => {});
      initLogStream();
      switchProviderTab('cline');
      renderWizardTargets();

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeCredentialsModal();
          closeComboWizard();
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
      window.startOAuthDeviceLogin = startOAuthDeviceLogin;
      window.syncLocalAccounts = syncLocalAccounts;
      window.nextWizardStep = nextWizardStep;
      window.prevWizardStep = prevWizardStep;
      window.addTargetToChain = addTargetToChain;
      window.addCustomTarget = addCustomTarget;
      window.removeWizardTarget = removeWizardTarget;
      window.onBackdropClick = onBackdropClick;
      window.fetchAccounts = fetchAccounts;
      window.fetchCombos = fetchCombos;
      window.fetchPlugins = fetchPlugins;
      window.fetchModels = fetchModels;
      window.filterModels = filterModels;
      window.setModelsFilter = setModelsFilter;
      window.probeModelLive = probeModelLive;
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
