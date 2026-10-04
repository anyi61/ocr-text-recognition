/** Backup restore and protected-history cleanup use read-only previews before a commit. */
(function (root) {
  'use strict';

  const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
  const ERROR_KEYS = Object.freeze({
    HISTORY_BACKUP_INVALID: 'history_restore_invalid',
    HISTORY_BACKUP_TOO_LARGE: 'history_restore_too_large',
    HISTORY_PREVIEW_STALE: 'history_management_stale',
    HISTORY_PREVIEW_EXPIRED: 'history_management_expired'
  });

  function mount({ announce = () => {} } = {}) {
    const byId = (id) => document.getElementById(id);
    const dialog = byId('historyManagementDialog');
    const title = byId('historyManagementTitle');
    const description = byId('historyManagementDescription');
    const filename = byId('historyManagementFile');
    const counts = byId('historyManagementCounts');
    const status = byId('historyManagementStatus');
    const confirm = byId('historyManagementConfirm');
    const cancel = byId('historyManagementCancel');
    const refresh = byId('historyManagementRefresh');
    const restore = byId('restoreHistoryBtn');
    const cleanup = byId('cleanupHistoryBtn');
    const input = byId('historyBackupFile');
    let session = null;
    let blocked = false;
    const t = (key, substitutions) => root.OCRI18n.t(key, substitutions);
    const send = (message) => chrome.runtime.sendMessage(message);
    const release = (token) => {
      if (token) send({ action: 'cancelHistoryPreview', token }).catch(() => {});
    };

    function render() {
      if (!session) return;
      const importing = session.mode === 'import';
      title.textContent = t(importing ? 'history_restore' : 'history_cleanup');
      description.textContent = t(importing ? 'history_restore_description' : 'history_cleanup_description');
      filename.textContent = session.fileName || '';
      filename.classList.toggle('hidden', !session.fileName);
      confirm.textContent = t(importing ? 'history_restore_confirm' : 'history_cleanup_confirm');
      confirm.disabled = Boolean(session.busy || !session.token || session.completed);
      confirm.classList.toggle('hidden', Boolean(session.completed));
      cancel.disabled = session.busy === 'commit';
      cancel.textContent = t(session.completed ? 'history_management_close' : 'history_management_cancel');
      refresh.textContent = t('history_management_refresh');
      refresh.classList.toggle('hidden', Boolean(session.completed || (importing && !session.backup)));
      refresh.disabled = Boolean(session.busy);
      status.textContent = session.busy
        ? t(session.busy === 'commit' ? 'history_management_saving' : 'history_management_loading')
        : session.messageKey ? t(session.messageKey, session.messageValues) : '';
      counts.replaceChildren();
      counts.classList.toggle('hidden', !session.preview);
      if (session.preview) {
        const fields = importing ? [
          ['history_restore_total', 'totalCount'],
          ['history_restore_added', 'importCount'],
          ['history_restore_duplicates', 'duplicateCount'],
          ['history_restore_capacity', 'capacitySkippedCount'],
          ['history_restore_favorites', 'favoriteCount'],
          ['history_restore_drafts', 'draftCount']
        ] : [
          ['history_cleanup_deleted', 'deleteCount'],
          ['history_cleanup_kept', 'keepCount'],
          ['history_cleanup_favorites', 'favoriteCount'],
          ['history_cleanup_drafts', 'draftCount']
        ];
        for (const [label, field] of fields) {
          const term = document.createElement('dt');
          term.textContent = t(label);
          const value = document.createElement('dd');
          value.dataset.count = field;
          value.textContent = String(session.preview[field] ?? 0);
          counts.append(term, value);
        }
      }
    }

    function close() {
      if (session?.busy === 'commit') return;
      release(session?.token);
      session = null;
      dialog.close();
      input.value = '';
    }

    function fail(current, code, fallback = 'history_management_failed') {
      if (session !== current) return;
      release(current.token);
      current.token = null;
      current.busy = null;
      current.messageKey = ERROR_KEYS[code] || fallback;
      render();
      announce(status.textContent);
    }

    async function preview(current) {
      if (session !== current || current.busy === 'commit') return;
      release(current.token);
      current.token = null;
      current.busy = 'preview';
      current.messageKey = '';
      render();
      try {
        const response = await send(current.mode === 'import'
          ? { action: 'previewHistoryImport', backup: current.backup }
          : { action: 'previewHistoryCleanup' });
        if (session !== current) {
          release(response?.preview?.token);
          return;
        }
        if (!response?.success || !response.preview?.token) {
          fail(current, response?.errorCode);
          return;
        }
        current.preview = response.preview;
        current.token = response.preview.token;
        current.busy = null;
        current.messageKey = 'history_management_ready';
        render();
      } catch {
        fail(current);
      }
    }

    function open(mode, fileName = '') {
      if (blocked || session?.busy === 'commit') return null;
      release(session?.token);
      session = { mode, fileName, busy: 'preview', preview: null, token: null, backup: null };
      render();
      if (!dialog.open) dialog.showModal();
      return session;
    }

    async function importFile(file) {
      const current = open('import', file.name);
      if (!current) return;
      if (file.size > MAX_BACKUP_BYTES) {
        fail(current, 'HISTORY_BACKUP_TOO_LARGE');
        return;
      }
      try {
        const raw = await file.text();
        if (session !== current) return;
        try { current.backup = JSON.parse(raw); }
        catch { fail(current, 'HISTORY_BACKUP_INVALID'); return; }
        await preview(current);
      } catch {
        fail(current, null, 'history_restore_read_failed');
      }
    }

    async function commit() {
      const current = session;
      if (!current?.token || current.busy || current.completed) return;
      current.busy = 'commit';
      render();
      try {
        const response = await send({
          action: current.mode === 'import' ? 'commitHistoryImport' : 'commitHistoryCleanup',
          token: current.token
        });
        if (session !== current) return;
        if (!response?.success) {
          fail(current, response?.errorCode);
          return;
        }
        current.token = null;
        current.busy = null;
        current.completed = true;
        current.messageKey = current.mode === 'import' ? 'history_restore_done' : 'history_cleanup_done';
        current.messageValues = [current.mode === 'import' ? response.importedCount : response.deletedCount];
        render();
        announce(status.textContent);
        cancel.focus();
      } catch {
        // A lost acknowledgement may follow a successful write. Always ask for
        // a new preview instead of replaying a consumed commit token.
        fail(current);
      }
    }

    restore.addEventListener('click', () => { if (!blocked) input.click(); });
    cleanup.addEventListener('click', () => {
      const current = open('cleanup');
      if (current) preview(current);
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.value = '';
      if (file) importFile(file);
    });
    cancel.addEventListener('click', close);
    refresh.addEventListener('click', () => { if (session && !session.busy) preview(session); });
    confirm.addEventListener('click', commit);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    // The popup also uses Escape and Ctrl+S for its editor. Dialog keystrokes
    // must stay in this workflow without closing or saving the editor behind it.
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    window.addEventListener('pagehide', () => release(session?.token));

    return {
      refreshLabels: render,
      isBusy: () => Boolean(session?.busy),
      setBlocked(value) {
        blocked = Boolean(value);
        restore.disabled = blocked;
        cleanup.disabled = blocked;
      },
      notifyHistoryChanged() {
        if (session?.token && !session.busy && !session.completed) {
          fail(session, 'HISTORY_PREVIEW_STALE');
        }
      }
    };
  }

  root.OCRHistoryManagementUI = Object.freeze({ mount, MAX_BACKUP_BYTES });
})(globalThis);
