import { HelpCircle, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
} from 'react';

import type { LevelRoute } from '../../parcel/ui/level-route';
import {
  HELP_CATEGORIES,
  LEVEL_GUIDE_ORDER,
  levelGuide,
  type HelpCategoryId,
  type HelpSection,
} from './help-content';
import './help.css';

function SectionCard({ section }: { section: HelpSection }) {
  return (
    <section className="help-card">
      <h3>{section.heading}</h3>
      {section.paragraphs?.map((text) => (
        <p key={text}>{text}</p>
      ))}
      {section.steps ? (
        <ol>
          {section.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
      {section.bullets ? (
        <ul>
          {section.bullets.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {section.note ? <p className="help-card__note">{section.note}</p> : null}
    </section>
  );
}

export function HelpDialog({ currentLevel }: { currentLevel: LevelRoute }) {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const panelId = `${baseId}-panel`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [openForLevel, setOpenForLevel] = useState<LevelRoute | null>(null);
  const [category, setCategory] = useState<HelpCategoryId>('getting-started');
  const [guideLevel, setGuideLevel] = useState<LevelRoute>(currentLevel);

  // A route change makes this false immediately, with no stale level guide.
  const open = openForLevel === currentLevel;

  const restoreFocus = useCallback(() => {
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    target?.focus();
  }, []);

  const closeDialog = useCallback(() => {
    setOpenForLevel(null);
    const dialog = dialogRef.current;
    if (dialog?.open) {
      dialog.close();
    }
    restoreFocus();
  }, [restoreFocus]);

  const openDialog = () => {
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== document.body
        ? active
        : triggerRef.current;
    setCategory('getting-started');
    setGuideLevel(currentLevel);
    setOpenForLevel(currentLevel);
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    const frame = window.requestAnimationFrame(() => {
      closeRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      bodyRef.current?.scrollTo({ top: 0 });
    }
  }, [category, guideLevel, open]);

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    closeDialog();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    // Keep Tab contained even when the browser would otherwise move focus to
    // browser chrome. Escape keeps its native cancel action.
    if (event.key === 'Tab') {
      const dialog = dialogRef.current;
      if (dialog) {
        const focusables = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]',
          ),
        ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (first && last) {
          if (!(active instanceof Node) || !dialog.contains(active)) {
            event.preventDefault();
            first.focus();
          } else if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    }
    // Stop every key from reaching the editor's window-level shortcuts behind
    // the modal. Do not prevent default, so Escape still cancels the dialog.
    event.stopPropagation();
  };

  const handleDialogClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) {
      closeDialog();
    }
  };

  const selectCategory = (next: HelpCategoryId) => {
    setCategory(next);
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const lastIndex = HELP_CATEGORIES.length - 1;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = index === lastIndex ? 0 : index + 1;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = index === 0 ? lastIndex : index - 1;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = lastIndex;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    const nextCategory = HELP_CATEGORIES[nextIndex];
    if (!nextCategory) {
      return;
    }
    selectCategory(nextCategory.id);
    tabRefs.current[nextIndex]?.focus();
  };

  const activeGuide = levelGuide(guideLevel);
  const activeCategory =
    HELP_CATEGORIES.find((item) => item.id === category) ?? HELP_CATEGORIES[0];
  const activeTabId = `${baseId}-tab-${activeCategory?.id ?? 'getting-started'}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="help-trigger"
        aria-haspopup="dialog"
        title="Open the help guide"
        onClick={openDialog}
      >
        <HelpCircle size={15} aria-hidden="true" />
        <span>Help</span>
      </button>

      <dialog
        ref={dialogRef}
        className="help-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onCancel={handleCancel}
        onClick={handleDialogClick}
        onKeyDown={handleKeyDown}
        onClose={() => {
          if (!dialogRef.current?.open) {
            setOpenForLevel(null);
          }
        }}
      >
        <div className="help-dialog__head">
          <div>
            <h2 id={titleId}>Help</h2>
            <p>A quick guide that works across all levels.</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="help-dialog__close"
            aria-label="Close help"
            onClick={closeDialog}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="help-dialog__tabs" role="tablist" aria-label="Help topics">
          {HELP_CATEGORIES.map((item, index) => {
            const selected = item.id === category;
            return (
              <button
                key={item.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                id={`${baseId}-tab-${item.id}`}
                className={`help-dialog__tab${selected ? ' is-active' : ''}`}
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectCategory(item.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        <div
          ref={bodyRef}
          className="help-dialog__body"
          id={panelId}
          role="tabpanel"
          aria-labelledby={activeTabId}
          tabIndex={0}
        >
          {category === 'level-guide' ? (
            <div className="help-level-guide">
              <div
                className="help-levels"
                role="group"
                aria-label="Choose a level guide"
              >
                {LEVEL_GUIDE_ORDER.map((route) => {
                  const guide = levelGuide(route);
                  const selected = route === guideLevel;
                  return (
                    <button
                      key={route}
                      type="button"
                      className={`help-levels__button${selected ? ' is-active' : ''}`}
                      aria-pressed={selected}
                      onClick={() => setGuideLevel(route)}
                    >
                      <span>{guide.title}</span>
                      {route === currentLevel ? (
                        <small>Current level</small>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <p className="help-level-note">
                Reading another level’s guide does not navigate, reset or change
                the game you are playing.
              </p>
              <header className="help-level-head">
                <h3>{activeGuide.title}</h3>
                <p>{activeGuide.tagline}</p>
              </header>
              <div className="help-sections">
                {activeGuide.sections.map((section) => (
                  <SectionCard key={section.heading} section={section} />
                ))}
              </div>
            </div>
          ) : (
            <div className="help-sections">
              {activeCategory?.sections.map((section) => (
                <SectionCard key={section.heading} section={section} />
              ))}
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
