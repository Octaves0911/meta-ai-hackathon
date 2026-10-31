import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemeMode } from './theme';

const OPTIONS: { mode: ThemeMode; label: string; icon: typeof Sun }[] = [
  { mode: 'light', label: 'Light', icon: Sun }, { mode: 'dark', label: 'Dark', icon: Moon }, { mode: 'system', label: 'System', icon: Monitor },
];

export function ThemeToggle() {
  const { mode, resolved, setMode } = useTheme();
  const Icon = resolved === 'dark' ? Moon : Sun;
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button className="ghost icon" aria-label="Change theme" title="Theme"><Icon size={18} /></button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="end" sideOffset={8}>
          {OPTIONS.map(({ mode: m, label, icon: I }) => (
            <Menu.Item key={m} className="menu-item" onSelect={() => setMode(m)}>
              <I size={16} /> {label} {mode === m && <Check size={15} style={{ marginLeft: 'auto' }} />}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
