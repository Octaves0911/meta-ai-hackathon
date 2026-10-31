import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

interface Props { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; wide?: boolean }

/** Accessible dialog (focus trap, Esc, labelled) used by every modal in the app. */
export function Modal({ open, onClose, title, description, children, wide }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={`dialog-content${wide ? ' wide' : ''}`} aria-describedby={description ? undefined : undefined}>
          <Dialog.Title asChild><h2>{title}</h2></Dialog.Title>
          {description ? <Dialog.Description className="muted" style={{ margin: '0 0 8px' }}>{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
          <Dialog.Close asChild><button className="dialog-close" aria-label="Close"><X size={18} /></button></Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
