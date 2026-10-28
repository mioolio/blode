import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { ChevronDown, ChevronRight, FilePlus, FolderOpen, FolderTree, RefreshCw } from 'lucide-react';
import type { Studio } from '../workspace/useStudio';
import { buildFileTree, type FileTreeNode } from '../workspace/fileTree';
import { bytes } from '../utils';
import { FileIcon, FolderIcon } from './FileIcon';
import { ContextMenu } from './ContextMenu';
import type { MenuTarget } from '../../../extensions/menus/types';

/** Workspace inventory is independent of which files the code editor can open. */
export function ProjectExplorer({ studio }: { studio: Studio }) {
  const {
    t,
    state,
    activePath,
    view,
    drafts,
    openFile,
    openProject,
    renamePath,
    setDeleteTarget,
    copy,
    busy,
    dirty,
    configDirty,
    perform,
    refresh,
    notify,
  } = studio;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapsedRoot, setCollapsedRoot] = useState('');
  const [creating, setCreating] = useState<{
    parent: string;
    value: string;
    kind: 'file' | 'directory';
  } | null>(null);
  const [renaming, setRenaming] = useState<{
    path: string;
    kind: 'file' | 'directory';
    value: string;
  } | null>(null);
  const [selected, setSelected] = useState<{ path: string; kind: 'file' | 'directory' } | null>(null);
  const submitting = useRef(false);
  const renamingSubmit = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number; node: FileTreeNode | null } | null>(null);
  const rootPath = state?.projectRoot ?? '';
  const rootName = rootPath.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? '';
  const nodes = useMemo(() => buildFileTree(state?.inventory?.entries ?? []), [state?.inventory?.entries]);
  const editableFiles = useMemo(() => new Set(state?.files.map((file) => file.path) ?? []), [state?.files]);
  const rootOpen = collapsedRoot !== rootPath;

  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const refreshTree = () =>
    void perform('action.refresh', async () => {
      if (dirty || configDirty) throw new Error('toast.saveFirst');
      await refresh();
    });
  const selectFile = (node: FileTreeNode) => {
    setSelected({ path: node.path, kind: 'file' });
    if (!node.editable || !editableFiles.has(node.path)) {
      notify(t('project.notEditable'), true);
      return;
    }
    openFile(node.path);
  };
  const openContextMenu = (event: ReactMouseEvent, node: FileTreeNode | null) => {
    event.preventDefault();
    event.stopPropagation();
    setSelected(node ? { path: node.path, kind: node.kind } : null);
    setMenu({ x: event.clientX, y: event.clientY, node });
  };
  const parentOf = (path: string) => {
    const parts = path.split('/');
    parts.pop();
    return parts.length ? `${parts.join('/')}/` : '';
  };
  const parentPrefix = (node: FileTreeNode | null) => {
    if (!node) return '';
    if (node.kind === 'directory') return `${node.path}/`;
    return parentOf(node.path);
  };
  /** Use the selected folder or the active file's folder instead of always the root. */
  const createParent = () => {
    const available = (path: string) =>
      state?.inventory.entries.some((entry) => entry.path === path) ?? false;
    if (selected && available(selected.path))
      return selected.kind === 'directory' ? `${selected.path}/` : parentOf(selected.path);
    if (activePath && available(activePath)) return parentOf(activePath);
    return '';
  };
  /** Inline creation: only the name is typed, in the tree row where it belongs. */
  const startCreate = (parent: string, kind: 'file' | 'directory' = 'file') => {
    const normalized = parent.replaceAll('\\', '/').replace(/\/+$/, '');
    setRenaming(null);
    setCreating({ parent: normalized ? `${normalized}/` : '', value: '', kind });
    setCollapsedRoot('');
    if (!normalized) return;
    const parts = normalized.split('/').filter(Boolean);
    setCollapsed((current) => {
      const next = new Set(current);
      for (let index = 0; index < parts.length; index++)
        next.delete(`${rootPath}:${parts.slice(0, index + 1).join('/')}`);
      return next;
    });
  };
  const finishCreate = () => {
    if (!creating || submitting.current) return;
    const name = creating.value.trim().replaceAll('\\', '/').replace(/^\/+/, '');
    if (!name) {
      setCreating(null);
      return;
    }
    submitting.current = true;
    const relative = `${creating.parent}${name}`;
    const kind = creating.kind;
    void perform('action.new', async () => {
      if (kind === 'directory') await window.blode.createDirectory(relative);
      else await window.blode.createFile(relative);
      setCreating(null);
      const next = await refresh();
      if (kind === 'directory') {
        setSelected({ path: relative, kind: 'directory' });
        setCollapsed((current) => {
          const updated = new Set(current);
          updated.delete(`${rootPath}:${relative}`);
          return updated;
        });
      } else if (next.files.some((file) => file.path === relative)) openFile(relative);
    }).finally(() => {
      submitting.current = false;
    });
  };
  /** Inline rename in place, with the base name selected like VS Code. */
  const startRename = (node: FileTreeNode) => {
    setCreating(null);
    setRenaming({ path: node.path, kind: node.kind, value: node.name });
  };
  const finishRename = () => {
    if (!renaming || renamingSubmit.current) return;
    const currentName = renaming.path.split('/').pop() ?? '';
    const name = renaming.value.trim();
    if (!name || name === currentName) {
      setRenaming(null);
      return;
    }
    if (/[\\/]/.test(name)) {
      notify(t('toast.invalidFile'), true);
      return;
    }
    const target = `${parentOf(renaming.path)}${name}`;
    renamingSubmit.current = true;
    void renamePath(renaming.path, target)
      .then((ok) => {
        if (ok) {
          setSelected({ path: target, kind: renaming.kind });
          setRenaming(null);
        }
      })
      .finally(() => {
        renamingSubmit.current = false;
      });
  };
  const createParentRef = useRef(createParent);
  createParentRef.current = createParent;
  useEffect(() => {
    const handler = () => startCreate(createParentRef.current());
    window.addEventListener('blode:new-file', handler);
    return () => window.removeEventListener('blode:new-file', handler);
  }, [rootPath]);
  const absolutePath = (relative: string) => {
    const root = rootPath.replaceAll('\\', '/').replace(/\/+$/, '');
    return relative ? `${root}/${relative}` : root;
  };
  const runMenuCommand = (command: string) => {
    const node = menu?.node ?? null;
    const path = node?.path ?? '';
    switch (command) {
      case 'explorer.newFile':
        startCreate(parentPrefix(node));
        break;
      case 'explorer.newFolder':
        startCreate(parentPrefix(node), 'directory');
        break;
      case 'explorer.reveal':
        void window.blode.revealEntry(path).catch((error) => notify(String(error), true));
        break;
      case 'explorer.copyPath':
        void copy(absolutePath(path));
        break;
      case 'explorer.copyRelativePath':
        void copy(path);
        break;
      case 'explorer.rename':
        if (node) startRename(node);
        break;
      case 'explorer.delete':
        setDeleteTarget(path);
        break;
      case 'explorer.refresh':
        refreshTree();
        break;
    }
  };

  const renderCreateRow = (depth: number) => (
    <div className="file-row explorer-row creating" style={{ paddingLeft: 6 }}>
      <span className="tree-indent" aria-hidden="true">
        {Array.from({ length: depth }, (_, index) => (
          <span className="tree-guide" key={index} />
        ))}
      </span>
      <span className="tree-disclosure" aria-hidden="true" />
      {creating?.kind === 'directory' ? (
        <FolderIcon open size={15} />
      ) : (
        <FileIcon name={creating?.value || 'untitled'} />
      )}
      <input
        className="tree-create-input"
        autoFocus
        value={creating?.value ?? ''}
        placeholder={t(creating?.kind === 'directory' ? 'project.folderName' : 'project.fileName')}
        disabled={!!busy}
        onChange={(event) => {
          const value = event.target.value;
          setCreating((current) => (current ? { ...current, value } : current));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            finishCreate();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setCreating(null);
          }
        }}
        onBlur={() => {
          if (!submitting.current) finishCreate();
        }}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );

  const renderRenameRow = (node: FileTreeNode, depth: number, open: boolean) => (
    <div className="file-row explorer-row renaming" style={{ paddingLeft: 6 }}>
      <span className="tree-indent" aria-hidden="true">
        {Array.from({ length: depth }, (_, index) => (
          <span className="tree-guide" key={index} />
        ))}
      </span>
      <span className="tree-disclosure" aria-hidden="true">
        {node.kind === 'directory' &&
          (open ? (
            <ChevronDown size={13} strokeWidth={2} />
          ) : (
            <ChevronRight size={13} strokeWidth={2} />
          ))}
      </span>
      {node.kind === 'directory' ? (
        <FolderIcon open={open} />
      ) : (
        <FileIcon name={renaming?.value || node.name} />
      )}
      <input
        className="tree-create-input"
        autoFocus
        value={renaming?.value ?? ''}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          const value = event.target.value;
          setRenaming((current) => (current ? { ...current, value } : current));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            finishRename();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setRenaming(null);
          }
        }}
        onBlur={() => {
          if (!renamingSubmit.current) finishRename();
        }}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );

  const renderNodes = (items: FileTreeNode[], depth: number) =>
    items.map((node) => {
      const isDirectory = node.kind === 'directory';
      const open = !collapsed.has(`${rootPath}:${node.path}`);
      const active = !isDirectory && activePath === node.path && view === 'code';
      return (
        <div
          key={`${node.kind}:${node.path}`}
          role="treeitem"
          aria-level={depth + 1}
          aria-expanded={isDirectory ? open : undefined}
          aria-selected={!isDirectory ? active : undefined}
        >
          {renaming?.path === node.path ? (
            renderRenameRow(node, depth, open)
          ) : (
            <button
              className={`file-row explorer-row ${isDirectory ? 'is-directory' : 'is-file'} ${active ? 'active' : ''}`}
              style={{ paddingLeft: 6 }}
              title={node.path}
              onClick={() => {
                if (isDirectory) {
                  setSelected({ path: node.path, kind: 'directory' });
                  toggle(`${rootPath}:${node.path}`);
                } else selectFile(node);
              }}
              onContextMenu={(event) => openContextMenu(event, node)}
            >
              <span className="tree-indent" aria-hidden="true">
                {Array.from({ length: depth }, (_, index) => (
                  <span className="tree-guide" key={index} />
                ))}
              </span>
              <span className="tree-disclosure" aria-hidden="true">
                {isDirectory &&
                  (open ? (
                    <ChevronDown size={13} strokeWidth={2} />
                  ) : (
                    <ChevronRight size={13} strokeWidth={2} />
                  ))}
              </span>
              {isDirectory ? <FolderIcon open={open} /> : <FileIcon name={node.name} />}
              <span className="tree-name">{node.name}</span>
              {!isDirectory &&
                (drafts[node.path] !== undefined ? (
                  <i className="dirty-dot" title={t('project.unsaved')} />
                ) : (
                  <small className="tree-file-size">{bytes(node.size)}</small>
                ))}
            </button>
          )}
          {isDirectory && open && (
            <>
              {creating?.parent === `${node.path}/` && renderCreateRow(depth + 1)}
              <div role="group">{renderNodes(node.children, depth + 1)}</div>
            </>
          )}
        </div>
      );
    });

  return (
    <aside className="project-panel">
      <div className="panel-heading">
        <span className="panel-title">
          <FolderTree size={14} strokeWidth={1.8} aria-hidden="true" />
          {t('project.title')}
        </span>
        {state && <span className="panel-badge">{state.inventory.fileCount}</span>}
      </div>
      <div className="explorer-actions">
        <button
          className="explorer-action wide"
          onClick={openProject}
          disabled={!!busy}
          title={t('project.openFolder')}
        >
          <FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" />
          <span>{t('project.openFolder')}</span>
        </button>
        <button
          className="explorer-action"
          onClick={() => startCreate(createParent())}
          disabled={!!busy || !state?.workspaceOpen}
          title={t('action.new')}
          aria-label={t('action.new')}
        >
          <FilePlus size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <button
          className="explorer-action"
          onClick={refreshTree}
          disabled={!!busy || !state?.workspaceOpen}
          title={t('action.refresh')}
          aria-label={t('action.refresh')}
        >
          <RefreshCw size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      {state?.workspaceOpen && (
        <button
          className="project-root explorer-root"
          title={rootPath}
          onClick={() => {
            setSelected(null);
            setCollapsedRoot(rootOpen ? rootPath : '');
          }}
          onContextMenu={(event) => openContextMenu(event, null)}
          aria-expanded={rootOpen}
        >
          {rootOpen ? (
            <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
          ) : (
            <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
          )}
          <FolderIcon open={rootOpen} size={16} />
          <strong>{rootName}</strong>
          <span className="root-tag">{t('project.localTag')}</span>
        </button>
      )}
      {state?.workspaceOpen ? (
        <div
          className="file-tree explorer-tree"
          role="tree"
          aria-label={t('project.title')}
          onContextMenu={(event) => {
            if (event.target === event.currentTarget) openContextMenu(event, null);
          }}
        >
          {rootOpen && creating?.parent === '' && renderCreateRow(0)}
          {rootOpen && renderNodes(nodes, 0)}
          {!nodes.length && <p className="subtle-note tree-empty">{t('project.noFiles')}</p>}
          {state.inventory.truncated && (
            <p className="subtle-note tree-empty">{t('project.inventoryTruncated')}</p>
          )}
        </div>
      ) : (
        <p className="subtle-note tree-empty">{t('welcome.noWorkspace')}</p>
      )}
      {menu && state?.workspaceOpen && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          target={menu.node ? (menu.node.kind === 'directory' ? 'folder' : 'file') : 'root'}
          onCommand={runMenuCommand}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}
