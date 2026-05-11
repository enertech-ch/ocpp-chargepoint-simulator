// Shared CSS for native form controls used inside every component.
// Shadow DOM means global stylesheet rules don't reach `<input>`/`<button>`
// rendered inside a component, so each LitElement that uses controls
// includes this module in its `static styles = [...]` array.
//
// Design tokens (CSS custom properties) come from src/ui/styles.css via
// :root; those pierce shadow boundaries automatically.

import { css } from './lit.js';

export const formStyles = css`
  /* Buttons */
  button {
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    background: var(--surface-2);
    color: var(--text);
    border: 1px solid var(--border);
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease,
                box-shadow 0.12s ease, transform 0.06s ease;
    letter-spacing: 0.01em;
  }
  button:hover { background: var(--surface-3); border-color: var(--border-strong); }
  button:active { transform: translateY(1px); }
  button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--accent-ring);
    border-color: var(--accent);
  }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button:disabled:hover { background: var(--surface-2); border-color: var(--border); }

  button.primary {
    background: var(--accent);
    color: #0d1117;
    border-color: var(--accent);
    font-weight: 600;
  }
  button.primary:hover { background: var(--accent-strong); border-color: var(--accent-strong); }

  button.ghost { background: transparent; border-color: transparent; }
  button.ghost:hover { background: var(--surface-2); border-color: var(--border); }

  button.danger { color: var(--err); }
  button.danger:hover {
    background: rgba(248, 113, 113, 0.1);
    border-color: var(--err);
    color: var(--err);
  }

  button.icon {
    padding: 6px 8px;
    background: transparent;
    border-color: transparent;
    color: var(--muted);
  }
  button.icon:hover { background: var(--surface-2); color: var(--text); border-color: var(--border); }

  /* Inputs / selects / textareas */
  input, select, textarea {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
  }
  input::placeholder, textarea::placeholder { color: var(--muted); opacity: 0.6; }
  input:hover, select:hover, textarea:hover { border-color: var(--border-strong); }
  input:focus, select:focus, textarea:focus {
    outline: none;
    border-color: var(--accent);
    background: var(--surface);
    box-shadow: 0 0 0 2px var(--accent-ring);
  }
  input:disabled, select:disabled, textarea:disabled { opacity: 0.5; cursor: not-allowed; }

  input[type="number"]::-webkit-outer-spin-button,
  input[type="number"]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  input[type="number"] { -moz-appearance: textfield; }

  select {
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'><path fill='%238b95a4' d='M0 0l5 6 5-6z'/></svg>");
    background-repeat: no-repeat;
    background-position: right 8px center;
    padding-right: 26px;
  }

  input[type="checkbox"], input[type="radio"] {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: 3px;
    cursor: pointer;
    padding: 0;
    position: relative;
    flex-shrink: 0;
  }
  input[type="radio"] { border-radius: 50%; }
  input[type="checkbox"]:hover, input[type="radio"]:hover { border-color: var(--accent); }
  input[type="checkbox"]:checked, input[type="radio"]:checked {
    background: var(--accent);
    border-color: var(--accent);
  }
  input[type="checkbox"]:checked::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 0;
    width: 5px;
    height: 9px;
    border: solid #0d1117;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
  input[type="radio"]:checked::after {
    content: '';
    position: absolute;
    left: 3px;
    top: 3px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #0d1117;
  }

  /* Subtle scrollbar */
  *::-webkit-scrollbar { width: 10px; height: 10px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 5px; border: 2px solid transparent; background-clip: content-box; }
  *::-webkit-scrollbar-thumb:hover { background: var(--border-strong); background-clip: content-box; }
`;
