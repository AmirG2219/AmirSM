import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton } from './ui';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Prevent closing via Esc/backdrop while something is in flight. */
  locked?: boolean;
}

/** Native <dialog>: focus trap, Esc to close and inert background come from the platform. */
export function Modal({ open, onClose, title, children, footer, locked }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useRef(`dlg-${Math.random().toString(36).slice(2, 9)}`).current;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Land on the first form field if there is one (otherwise the browser's default, the close button, keeps focus).
      d.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]):not([type=radio]), textarea, select')?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!locked) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !locked) onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
    >
      {open ? (
        <>
          <div className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <IconButton icon="x" label="Close" size="sm" onClick={onClose} disabled={locked} />
          </div>
          <div className="dialog-body">{children}</div>
          {footer ? <div className="dialog-foot">{footer}</div> : null}
        </>
      ) : null}
    </dialog>
  );
}
