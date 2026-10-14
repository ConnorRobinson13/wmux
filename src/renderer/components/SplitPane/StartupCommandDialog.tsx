import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store';
import { getAllPaneIds, findLeaf } from '../../store/split-utils';
import { useT } from '../../i18n';
import { requestSessionSaveNow } from '../../utils/session-save-now';
import type { PaneId, SurfaceId, WorkspaceId } from '../../../shared/types';

/**
 * Edit a live terminal's startup commands (#284) — the first thing that issue
 * asked for: "a pane's startup command can be entered/edited by the user and
 * survives save → restore". They land in `SurfaceRef.startupCommands`, the
 * field quick-launch profiles (#32) and restore (#186) already use, so they
 * run the next time this pane STARTS — on restore, or from a saved session or
 * layout — and are what `wmux workspace save` writes as the pane's `run`.
 * Nothing is typed into the running shell now.
 */
export default function StartupCommandDialog({ surfaceId, onClose }: { surfaceId: SurfaceId; onClose: () => void }) {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const updateSurface = useStore((s) => s.updateSurface);
  const located = useMemo(() => {
    for (const ws of workspaces) {
      for (const pid of getAllPaneIds(ws.splitTree)) {
        const surface = findLeaf(ws.splitTree, pid)?.surfaces.find((s) => s.id === surfaceId);
        if (surface) return { workspaceId: ws.id as WorkspaceId, paneId: pid as PaneId, commands: surface.startupCommands ?? [] };
      }
    }
    return null;
  }, [workspaces, surfaceId]);
  const [text, setText] = useState(() => (located?.commands ?? []).join('\n'));
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { areaRef.current?.focus(); }, []);

  if (!located) return null;

  const save = () => {
    const commands = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    updateSurface(located.workspaceId, located.paneId, surfaceId, { startupCommands: commands.length ? commands : undefined });
    // Straight to disk (#285): a startup command only matters after a restart,
    // so the 30 s auto-save tick is the one place it must not wait.
    requestSessionSaveNow();
    onClose();
  };

  return createPortal(
    <div className="confirm-dialog__overlay" onClick={onClose}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('surfaceTab.startupCommand', 'Startup command…')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        }}
      >
        <div className="confirm-dialog__title">{t('surfaceTab.startupCommandTitle', 'Startup commands')}</div>
        <div className="confirm-dialog__message">
          {t('surfaceTab.startupCommandHint', 'One command per line. They run when this pane starts — on restore, or when a saved session or layout opens it — and nothing runs now.')}
        </div>
        <textarea
          ref={areaRef}
          className="startup-command-dialog__input"
          value={text}
          spellCheck={false}
          rows={4}
          placeholder="npm run dev"
          onChange={(e) => setText(e.target.value)}
        />
        <div className="confirm-dialog__actions">
          <button className="confirm-dialog__btn" onClick={onClose}>{t('confirmClose.cancel', 'Cancel')}</button>
          <button className="confirm-dialog__btn confirm-dialog__btn--primary" onClick={save}>{t('surfaceTab.startupCommandSave', 'Save')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
