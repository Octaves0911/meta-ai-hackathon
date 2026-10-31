import * as Dialog from '@radix-ui/react-dialog';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

interface Options { title: string; message?: string; confirmLabel?: string; danger?: boolean }
type Ask = (o: Options) => Promise<boolean>;
const Ctx = createContext<Ask>(async () => false);

/** `const confirm = useConfirm(); if (await confirm({...})) …` — an accessible replacement for window.confirm. */
export const useConfirm = () => useContext(Ctx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const resolver = useRef<(v: boolean) => void>(() => {});
  const ask = useCallback<Ask>((o) => new Promise<boolean>((resolve) => { resolver.current = resolve; setOpts(o); }), []);
  const close = (v: boolean) => { resolver.current(v); setOpts(null); };
  return (
    <Ctx.Provider value={ask}>
      {children}
      <Dialog.Root open={!!opts} onOpenChange={(o) => !o && close(false)}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content" style={{ width: 'min(440px, calc(100vw - 32px))' }}>
            <Dialog.Title asChild><h2>{opts?.title}</h2></Dialog.Title>
            <Dialog.Description className="muted" style={{ margin: 0 }}>{opts?.message ?? ' '}</Dialog.Description>
            <div className="dialog-actions">
              <button onClick={() => close(false)}>Cancel</button>
              <button className={opts?.danger ? 'primary danger-solid' : 'primary'} onClick={() => close(true)} autoFocus>{opts?.confirmLabel ?? 'Confirm'}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Ctx.Provider>
  );
}
