import React, { useState } from 'react';
import { Folder, FolderOpen, ChevronRight, ChevronDown, File, Trash2, Edit2, FolderPlus } from 'lucide-react';
import { Button } from './ui/button';

const FolderNode = ({
  folder,
  folders,
  strategies,
  level = 0,
  onDropStrategy,
  onDeleteFolder,
  onRenameFolder,
  onCreateFolder,
  onToggleCombine,
  selectedForCombined,
  renderStrategyRow,
  searchTerm
}) => {
  const [isOpen, setIsOpen] = useState(false);

  // Subfolders
  const childFolders = folders.filter(f => f.parent_id === folder.id);
  // Strategies in this folder
  const childStrategies = strategies.filter(s => s.folder_id === folder.id);

  // If there's a search term, we should auto-expand if any children match
  const matchesSearch = (item) => {
    if (!searchTerm) return true;
    const s = searchTerm.toLowerCase();
    const name = (item.name || item.config?.name || '').toLowerCase();
    const id = (item.id || '').toLowerCase();
    return name.includes(s) || id.includes(s);
  };

  const visibleStrategies = childStrategies.filter(matchesSearch);
  
  // Recursively check if this folder contains matching items
  const hasMatchingDescendants = (folderId) => {
      if (!searchTerm) return true;
      const directStrs = strategies.filter(s => s.folder_id === folderId);
      if (directStrs.some(matchesSearch)) return true;
      
      const sub = folders.filter(f => f.parent_id === folderId);
      for (const sf of sub) {
          if (sf.name.toLowerCase().includes(searchTerm.toLowerCase())) return true;
          if (hasMatchingDescendants(sf.id)) return true;
      }
      return false;
  };

  const isVisible = !searchTerm || folder.name.toLowerCase().includes(searchTerm.toLowerCase()) || hasMatchingDescendants(folder.id);

  const getDescendantCounts = (folderId) => {
      const directStrs = strategies.filter(s => s.folder_id === folderId).length;
      const sub = folders.filter(f => f.parent_id === folderId);
      
      let totalStrategies = directStrs;
      let totalFolders = sub.length;
      
      for (const sf of sub) {
          const counts = getDescendantCounts(sf.id);
          totalStrategies += counts.strategies;
          totalFolders += counts.folders;
      }
      return { strategies: totalStrategies, folders: totalFolders };
  };

  const { strategies: totalStratCount, folders: totalFolderCount } = getDescendantCounts(folder.id);

  if (!isVisible) return null;

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('bg-muted/50');
  };

  const handleDragLeave = (e) => {
    e.currentTarget.classList.remove('bg-muted/50');
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.currentTarget.classList.remove('bg-muted/50');
    const strategyId = e.dataTransfer.getData('text/plain');
    if (strategyId) {
      onDropStrategy(strategyId, folder.id);
    }
  };

  return (
    <div className="flex flex-col w-full text-[10px] sm:text-xs">
      {/* Folder Header Row */}
      <div 
        className="flex items-center justify-between px-4 py-2 border-b bg-muted/20 hover:bg-muted/40 transition-colors cursor-pointer group"
        style={{ paddingLeft: `${Math.min(level, 4) * 12 + 16}px` }}
        onClick={() => setIsOpen(!isOpen)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="flex items-center gap-2 overflow-hidden">
          {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          {isOpen ? <FolderOpen className="h-4 w-4 shrink-0 text-blue-500" /> : <Folder className="h-4 w-4 shrink-0 text-blue-500" />}
          <span className="font-semibold truncate">{folder.name}</span>
          <span className="text-muted-foreground ml-2 text-[10px] whitespace-nowrap">
            ({totalStratCount} {totalStratCount === 1 ? 'strategy' : 'strategies'}
            {totalFolderCount > 0 ? `, ${totalFolderCount} ${totalFolderCount === 1 ? 'folder' : 'folders'}` : ''})
          </span>
        </div>
        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 hover:bg-slate-200 rounded text-slate-500"
            onClick={(e) => {
              e.stopPropagation();
              onCreateFolder(folder.id);
            }}
            title="New Subfolder"
          >
            <FolderPlus className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 hover:bg-slate-200 rounded text-slate-500"
            onClick={(e) => {
              e.stopPropagation();
              onRenameFolder(folder);
            }}
            title="Rename Folder"
          >
            <Edit2 className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 hover:bg-red-100 hover:text-red-600 rounded text-slate-500"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteFolder(folder.id);
            }}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Folder Contents */}
      {(isOpen || searchTerm) && (
        <div className="flex flex-col border-l border-muted ml-[22px]">
          {/* Subfolders */}
          {childFolders.map(childFolder => (
            <FolderNode
              key={childFolder.id}
              folder={childFolder}
              folders={folders}
              strategies={strategies}
              level={level + 1}
              onDropStrategy={onDropStrategy}
              onDeleteFolder={onDeleteFolder}
              onRenameFolder={onRenameFolder}
              onCreateFolder={onCreateFolder}
              onToggleCombine={onToggleCombine}
              selectedForCombined={selectedForCombined}
              renderStrategyRow={renderStrategyRow}
              searchTerm={searchTerm}
            />
          ))}

          {/* Strategies */}
          {visibleStrategies.length > 0 && (
            <div className="flex flex-col">
              <div 
                className="hidden xl:grid xl:grid-cols-12 gap-4 px-4 py-2 bg-slate-50/50 text-slate-500 border-b text-[9px] font-black uppercase tracking-wider items-center"
                style={{ paddingLeft: `${Math.min(level + 1, 4) * 12 + 16}px` }}
              >
                <div className="col-span-3 pl-[52px]">Name</div>
                <div className="col-span-2">Date Created</div>
                <div className="col-span-1">Index</div>
                <div className="col-span-2">Type</div>
                <div className="col-span-4 text-right pr-6">Actions</div>
              </div>
              {visibleStrategies.map(s => renderStrategyRow(s, level + 1))}
            </div>
          )}

          {visibleStrategies.length === 0 && childFolders.length === 0 && !searchTerm && (
            <div 
                className="px-4 py-3 text-muted-foreground italic border-b"
                style={{ paddingLeft: `${Math.min(level + 1, 4) * 12 + 16}px` }}
            >
              Folder is empty. Drag strategies here.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const FolderTree = ({
  folders,
  strategies,
  onDropStrategy,
  onDeleteFolder,
  onRenameFolder,
  onCreateFolder,
  onToggleCombine,
  selectedForCombined,
  renderStrategyRow,
  searchTerm
}) => {
  // Root level folders and strategies
  const rootFolders = folders.filter(f => !f.parent_id);
  const rootStrategies = strategies.filter(s => !s.folder_id);

  const handleRootDrop = (e) => {
    e.preventDefault();
    e.currentTarget.classList.remove('bg-muted/10');
    const strategyId = e.dataTransfer.getData('text/plain');
    if (strategyId) {
      onDropStrategy(strategyId, null);
    }
  };

  return (
    <div className="flex flex-col w-full divide-y border-t">
      {/* Root Folders */}
      {rootFolders.map(folder => (
        <FolderNode
          key={folder.id}
          folder={folder}
          folders={folders}
          strategies={strategies}
          level={0}
          onDropStrategy={onDropStrategy}
          onDeleteFolder={onDeleteFolder}
          onRenameFolder={onRenameFolder}
          onCreateFolder={onCreateFolder}
          onToggleCombine={onToggleCombine}
          selectedForCombined={selectedForCombined}
          renderStrategyRow={renderStrategyRow}
          searchTerm={searchTerm}
        />
      ))}

      {/* Root Strategies Container (Also acts as drop target for root) */}
      <div 
        className="flex flex-col min-h-[50px] transition-colors"
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          e.currentTarget.classList.add('bg-muted/10');
        }}
        onDragLeave={(e) => {
          e.currentTarget.classList.remove('bg-muted/10');
        }}
        onDrop={handleRootDrop}
      >
        {/* Root Strategies Header */}
        {rootStrategies.length > 0 && (
          <div className="hidden xl:grid xl:grid-cols-12 gap-4 px-4 py-2 bg-slate-50/50 text-slate-500 border-b border-t text-[9px] font-black uppercase tracking-wider items-center">
            <div className="col-span-3 pl-[52px]">Name</div>
            <div className="col-span-2">Date Created</div>
            <div className="col-span-1">Index</div>
            <div className="col-span-2">Type</div>
            <div className="col-span-4 text-right">Actions</div>
          </div>
        )}
        {rootStrategies
          .filter(s => {
            if (!searchTerm) return true;
            const sTerm = searchTerm.toLowerCase();
            const name = (s.name || s.config?.name || '').toLowerCase();
            const id = (s.id || '').toLowerCase();
            return name.includes(sTerm) || id.includes(sTerm);
          })
          .map(s => renderStrategyRow(s, 0))}
          
        {rootStrategies.length === 0 && rootFolders.length === 0 && !searchTerm && (
            <div className="px-4 py-8 text-center text-muted-foreground w-full flex flex-col items-center gap-2">
                <FolderOpen className="h-8 w-8 opacity-20" />
                <p>No strategies found. Create your first strategy!</p>
            </div>
        )}
      </div>
    </div>
  );
};

export default FolderTree;
