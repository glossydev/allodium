/**
 * The consumer's stylesheet for the unstyled admin components.
 *
 * This is the entire styling contract, demonstrated: plain CSS, every rule
 * targeting a data-allodium attribute. It lives in the CONSUMER — a real
 * dashboard would own a file exactly like this — because the components ship no
 * styles of their own.
 */
export const PREVIEW_CSS = `
.allodium-preview { color: #d4d4d8; max-width: 60rem; }
.allodium-preview h1 { font-size: 1.05rem; font-weight: 600; color: #fafafa; }
.allodium-preview [data-allodium="description"] { font-size: .75rem; color: #a1a1aa; margin-top: .15rem; }

.allodium-preview [data-allodium="list-header"],
.allodium-preview [data-allodium="form-header"] { display: flex; align-items: baseline; gap: .75rem; margin-bottom: .75rem; flex-wrap: wrap; }
.allodium-preview [data-allodium="search"] { margin-left: auto; }

.allodium-preview input, .allodium-preview textarea, .allodium-preview select {
  background: #09090b; border: 1px solid #3f3f46; border-radius: .25rem;
  color: #e4e4e7; padding: .25rem .5rem; font-size: .75rem; font-family: inherit;
}
.allodium-preview input:focus, .allodium-preview textarea:focus, .allodium-preview select:focus {
  outline: none; border-color: #059669;
}
.allodium-preview input[type="checkbox"], .allodium-preview input[type="radio"] { accent-color: #10b981; }
.allodium-preview textarea { width: 100%; min-height: 5rem; font-family: ui-monospace, monospace; }

.allodium-preview button {
  background: #18181b; border: 1px solid #3f3f46; border-radius: .25rem;
  color: #d4d4d8; padding: .25rem .625rem; font-size: .75rem; cursor: pointer;
}
.allodium-preview button:hover:not(:disabled) { border-color: #52525b; color: #fafafa; }
.allodium-preview button:disabled { opacity: .4; cursor: default; }
.allodium-preview [data-allodium="save"] { background: #059669; border-color: #059669; color: #fff; font-weight: 500; }
.allodium-preview [data-allodium="delete"] { border-color: #7f1d1d; color: #fca5a5; }

/* Filters. The operator's own are chips they can remove; the view's baseline is
   a stated note with no remove control, because it has no remove behaviour —
   styling them alike would promise something the runtime will not honour. */
.allodium-preview [data-allodium="filters"] { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin-bottom: .6rem; }
.allodium-preview [data-allodium="filter-baseline"] {
  width: 100%; margin: 0 0 .1rem; font-size: .7rem; color: #a1a1aa;
  border-left: 2px solid #3f3f46; padding-left: .5rem;
}
.allodium-preview [data-allodium="filter-chips"] { display: contents; list-style: none; margin: 0; padding: 0; }
.allodium-preview [data-allodium="filter-chip"] {
  display: inline-flex; align-items: center; gap: .35rem;
  background: rgba(6,78,59,.35); border: 1px solid #065f46; border-radius: 999px;
  padding: .1rem .25rem .1rem .55rem; font-size: .7rem; color: #d1fae5;
}
.allodium-preview [data-allodium="filter-remove"] {
  background: none; border: none; padding: 0 .25rem; line-height: 1;
  color: #6ee7b7; font-size: .8rem; border-radius: 999px;
}
.allodium-preview [data-allodium="filter-remove"]:hover { color: #fff; background: rgba(6,95,70,.6); }
.allodium-preview [data-allodium="filter-draft"] { display: inline-flex; align-items: center; gap: .3rem; flex-wrap: wrap; }
.allodium-preview [data-allodium="filter-apply"] { border-color: #059669; color: #6ee7b7; }
.allodium-preview [data-allodium="filter-add"] { border-style: dashed; }

.allodium-preview [data-allodium="table"] { width: 100%; border-collapse: collapse; font-size: .75rem; }
.allodium-preview th { text-align: left; border-bottom: 1px solid #27272a; padding: .35rem .5rem; font-weight: 500; color: #a1a1aa; }
.allodium-preview th button { background: none; border: none; padding: 0; color: inherit; font: inherit; }
.allodium-preview td { border-bottom: 1px solid #1c1c1f; padding: .35rem .5rem; }
.allodium-preview [data-allodium="row"]:hover { background: rgba(6,78,59,.25); cursor: pointer; }
.allodium-preview [data-allodium="null"]::before { content: "\\2205"; color: #52525b; }
.allodium-preview [data-allodium="empty"] { text-align: center; color: #71717a; padding: 1.5rem; }

.allodium-preview [data-allodium="field"] { margin-bottom: .9rem; display: flex; flex-direction: column; gap: .2rem; }
.allodium-preview [data-allodium="label"] { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; color: #a1a1aa; }
.allodium-preview [data-allodium="required-mark"] { color: #10b981; }
.allodium-preview [data-allodium="help"] { font-size: .7rem; color: #71717a; }
.allodium-preview [data-allodium="field-error"] { font-size: .7rem; color: #f87171; }
.allodium-preview [data-invalid] input, .allodium-preview [data-invalid] select { border-color: #b91c1c; }

/* Relation and many-to-many pickers lay out inline; nothing about that is in the component. */
.allodium-preview [data-allodium="radiogroup"],
.allodium-preview [data-allodium="checkboxes"] { display: flex; flex-wrap: wrap; gap: .75rem; padding: .2rem 0; }
.allodium-preview [data-allodium="radio"],
.allodium-preview [data-allodium="checkbox-option"] { display: flex; align-items: center; gap: .3rem; font-size: .75rem; }

.allodium-preview [data-allodium="form-actions"] { display: flex; gap: .5rem; margin-top: 1.25rem; border-top: 1px solid #27272a; padding-top: .75rem; }
.allodium-preview [data-allodium="pagination"] { display: flex; align-items: center; gap: .5rem; margin-top: .75rem; font-size: .7rem; color: #a1a1aa; }
.allodium-preview [data-allodium="error"] { color: #f87171; font-size: .75rem; }
.allodium-preview [data-allodium="loading"] { color: #71717a; font-size: .75rem; }

/* Field-specific tuning, to show that per-column targeting works. */
.allodium-preview [data-field="body"] textarea { min-height: 8rem; }
.allodium-preview [data-field="views"] input { max-width: 8rem; }
.allodium-preview [data-widget="text"] input, .allodium-preview [data-widget="datetime"] input { max-width: 28rem; }
`;
