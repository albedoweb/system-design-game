import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

import './game-ui.css';

export interface SidePanelTab {
  id: string;
  label: string;
}

export interface SidePanelProps {
  side: 'left' | 'right';
  /** Accessible name of the region, e.g. "Task and components". */
  label: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Left panels expose Task/Components as a tab list. */
  tabs?: SidePanelTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  tabsLabel?: string;
  closeLabel?: string;
  className?: string;
}

/**
 * Shared side panel used for the level task/components drawer and the
 * inspector. Presentation is controlled; routing of the active tab and the
 * panel content stay with the level.
 *
 * When tabs are used this implements the complete tabs pattern: roving
 * tabIndex, Left/Right/Home/End navigation, `aria-controls` on each tab and a
 * labelled `tabpanel` for the content. The close action lives outside the
 * tablist so assistive technology does not treat it as a tab.
 */
export function SidePanel({
  side,
  label,
  open,
  onClose,
  children,
  tabs,
  activeTab,
  onTabChange,
  tabsLabel = 'Left panel',
  closeLabel = side === 'left' ? 'Close left panel' : 'Close inspector',
  className,
}: SidePanelProps) {
  const baseId = useId();
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const tabList = tabs ?? [];
  const hasTabs = tabList.length > 0;
  const currentTab = tabList.find((tab) => tab.id === activeTab) ?? tabList[0];
  const panelId = `${baseId}-panel`;

  const selectTab = (index: number) => {
    if (!hasTabs) {
      return;
    }
    const next = tabList[(index + tabList.length) % tabList.length];
    if (!next) {
      return;
    }
    onTabChange?.(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!hasTabs) {
      return;
    }
    const index = tabList.findIndex((tab) => tab.id === activeTab);
    const current = index >= 0 ? index : 0;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        selectTab(current + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        selectTab(current - 1);
        break;
      case 'Home':
        event.preventDefault();
        selectTab(0);
        break;
      case 'End':
        event.preventDefault();
        selectTab(tabList.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <aside
      className={[
        'game-side-panel',
        `game-side-panel--${side}`,
        open ? 'is-open' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label={label}
    >
      {hasTabs ? (
        <div className="game-side-tabs">
          <div
            className="game-side-tabs__list"
            role="tablist"
            aria-label={tabsLabel}
            onKeyDown={handleTabKeyDown}
          >
            {tabList.map((tab) => {
              const selected = currentTab?.id === tab.id;
              return (
                <button
                  type="button"
                  role="tab"
                  key={tab.id}
                  id={`${baseId}-tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected ? 0 : -1}
                  ref={(element) => {
                    if (element) {
                      tabRefs.current.set(tab.id, element);
                    } else {
                      tabRefs.current.delete(tab.id);
                    }
                  }}
                  className={selected ? 'is-active' : ''}
                  onClick={() => onTabChange?.(tab.id)}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="game-side-tabs__close"
            aria-label={closeLabel}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="game-side-panel__close"
          aria-label={closeLabel}
          onClick={onClose}
        >
          ✕
        </button>
      )}
      <div
        className="game-side-scroll"
        id={hasTabs ? panelId : undefined}
        role={hasTabs ? 'tabpanel' : undefined}
        aria-labelledby={
          hasTabs && currentTab ? `${baseId}-tab-${currentTab.id}` : undefined
        }
        tabIndex={hasTabs ? 0 : undefined}
      >
        {children}
      </div>
    </aside>
  );
}
