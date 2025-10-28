import fse from 'fs-extra';
import * as path from 'path';
import {
  QvLibrary, QvLibraryMeta, QvNote, QvNotebook, QvNotebookMeta, QvNoteContent, QvNoteMeta, QvNoteResourceFile,
} from './type.js';

/**
 * Check if a path is a valid Quiver note directory.
 *
 * @param notePath - Path to check
 * @returns True if path is a .qvnote directory, false otherwise
 */
const isQvNote = async (notePath: string): Promise<boolean> => {
  try {
    const stat = await fse.stat(notePath);
    if (stat.isDirectory() && notePath.endsWith('.qvnote')) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
};

/**
 * Read note metadata from meta.json file.
 *
 * @param metaPath - Path to the meta.json file
 * @returns Parsed note metadata
 * @throws Error if file doesn't exist or is invalid
 */
const readNoteMeta = async (metaPath:string): Promise<QvNoteMeta> => {
  try {
    const stat = await fse.stat(metaPath);
    if (stat.isFile()) {
      const content = await fse.readFile(metaPath);
      return JSON.parse(content.toString()) as QvNoteMeta;
    }
    throw new Error(`no such file ${metaPath}`);
  } catch (error) {
    throw (error as Error);
  }
};

/**
 * Read note content from content.json file.
 *
 * @param contentPath - Path to the content.json file
 * @returns Parsed note content with cells
 * @throws Error if file doesn't exist or is invalid
 */
export const readNoteContent = async (contentPath: string): Promise<QvNoteContent> => {
  try {
    const stat = await fse.stat(contentPath);
    if (stat.isFile()) {
      const content = await fse.readFile(contentPath);
      return JSON.parse(content.toString()) as QvNoteContent;
    }
    throw new Error(`no such file ${contentPath}`);
  } catch (error) {
    throw (error as Error);
  }
};

/**
 * Read resource files from a note's resources directory.
 *
 * @param resourcesPath - Path to the resources directory
 * @returns Array of resource files, or undefined if directory doesn't exist
 * @throws Error if path exists but is not a directory
 */
const readNoteResources = async (resourcesPath: string): Promise<QvNoteResourceFile[] | undefined> => {
  if (!await fse.pathExists(resourcesPath)) {
    return undefined;
  }
  try {
    const stat = await fse.stat(resourcesPath);
    if (stat.isDirectory()) {
      const names = await fse.readdir(resourcesPath);
      const resources: QvNoteResourceFile[] = [];
      names.forEach((name) => {
        resources.push({ name });
      });
      return resources;
    }
    throw new Error(`no such directory ${resourcesPath}`);
  } catch (error) {
    throw (error as Error);
  }
};

/**
 * Read a complete Quiver note from a .qvnote directory.
 *
 * @param notePath - Path to the .qvnote directory
 * @returns Complete note object with metadata and resource references
 * @throws Error if path is not a valid note directory or required files are missing
 */
const readNote = async (notePath: string): Promise<QvNote> => {
  if (!isQvNote(notePath)) {
    throw new Error(`${notePath} is not a quiver note dir, please check and try again`);
  }
  const meta = await readNoteMeta(path.join(notePath, 'meta.json'));
  // delay read
  const contentPath = path.join(notePath, 'content.json');
  if (!fse.existsSync(contentPath)) {
    throw new Error(`no such file ${contentPath}`);
  }
  const resourceFiles = await readNoteResources(path.join(notePath, 'resources'));
  const note: QvNote = {
    meta,
    notePath,
    contentPath,
  };
  if (resourceFiles) {
    note.resources = { files: resourceFiles };
  }
  return note;
};

/**
 * Check if a path is a valid Quiver notebook directory.
 *
 * @param notebookPath - Path to check
 * @returns True if path is a .qvnotebook directory, false otherwise
 */
const isQvNoteBook = async (notebookPath: string): Promise<boolean> => {
  try {
    const stat = await fse.stat(notebookPath);
    if (stat.isDirectory() && notebookPath.endsWith('.qvnotebook')) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
};

/**
 * Read notebook metadata from meta.json file.
 *
 * @param metaPath - Path to the meta.json file
 * @returns Parsed notebook metadata
 */
const readNotebookMeta = async (metaPath: string): Promise<QvNotebookMeta> => {
  const content = await fse.readFile(metaPath);
  return JSON.parse(content.toString()) as QvNotebookMeta;
};

/**
 * Read a complete Quiver notebook from a .qvnotebook directory.
 *
 * @param notebookPath - Path to the .qvnotebook directory
 * @returns Complete notebook object with metadata and notes
 * @throws Error if path is not a valid notebook directory or meta.json is missing
 */
const readNoteBook = async (notebookPath: string): Promise<QvNotebook> => {
  if (!await isQvNoteBook(notebookPath)) {
    throw new Error(`${notebookPath} is not a quiver notebook dir, please check and try again`);
  }
  const names = await fse.readdir(notebookPath);
  let meta: QvNotebookMeta | undefined;
  const notes: QvNote[] = [];
  await Promise.all(names.map(async (name) => {
    const filePath = path.join(notebookPath, name);
    const stat = fse.statSync(filePath);
    if (stat.isFile() && name === 'meta.json') {
      // read library meta
      meta = await readNotebookMeta(filePath);
    } else if (stat.isDirectory()) {
      // read notebook
      notes.push(await readNote(filePath));
    }
  }));

  if (!meta) {
    throw new Error(`no such file ${path.join(notebookPath, 'meta.json')}`);
  }
  return {
    meta,
    notes,
  };
};

/**
 * Check if a path is a valid Quiver library directory.
 *
 * @param libraryPath - Path to check
 * @returns True if path is a .qvlibrary directory, false otherwise
 */
const isQvLibrary = async (libraryPath: string): Promise<boolean> => {
  try {
    const stat = fse.statSync(libraryPath);
    if (stat.isDirectory() && libraryPath.endsWith('.qvlibrary')) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
};

/**
 * Read library metadata from meta.json file.
 *
 * @param metaPath - Path to the meta.json file
 * @returns Parsed library metadata with hierarchy structure
 */
const readLibraryMeta = async (metaPath: string): Promise<QvLibraryMeta> => {
  const content = await fse.readFile(metaPath);
  return JSON.parse(content.toString()) as QvLibraryMeta;
};

/**
 * Read a complete Quiver library from a .qvlibrary directory.
 * Loads all notebooks and the hierarchy metadata.
 * Automatically ignores system directories (.git, node_modules, .DS_Store).
 *
 * @param libraryPath - Path to the .qvlibrary directory
 * @returns Complete library object with metadata and all notebooks
 * @throws Error if path is not a valid library directory or meta.json is missing
 */
export const readLibrary = async (libraryPath: string): Promise<QvLibrary> => {
  if (!await isQvLibrary(libraryPath)) {
    throw new Error(`${libraryPath} is not a quiver library dir, please check and try again`);
  }

  const names = await fse.readdir(libraryPath);
  let meta: QvLibraryMeta | undefined;
  const notebooks: QvNotebook[] = [];

  // Directories to ignore when reading library.
  // These are system/development directories that should not be processed as notebooks.
  // - .git: Git repository data
  // - node_modules: npm dependencies
  // - .DS_Store: macOS system file
  const ignoredDirs = new Set(['.git', 'node_modules', '.DS_Store']);

  await Promise.all(names.map(async (name) => {
    // Skip ignored directories
    if (ignoredDirs.has(name)) {
      return;
    }

    const filePath = path.join(libraryPath, name);
    const stat = await fse.stat(filePath);
    if (stat.isFile() && name === 'meta.json') {
      // read library meta
      meta = await readLibraryMeta(filePath);
    } else if (stat.isDirectory()) {
      // read notebook
      notebooks.push(await readNoteBook(filePath));
    }
  }));

  if (!meta) {
    throw new Error(`no such file ${path.join(libraryPath, 'meta.json')}`);
  }
  return {
    meta,
    notebooks,
  };
};

/**
 * Recursively walk through the notebook hierarchy from library metadata.
 * Performs a depth-first traversal, invoking the callback for each notebook.
 *
 * @param libraryMeta - The library metadata node to start from (can be root or any child)
 * @param parents - Array of parent UUIDs (path from root to current node)
 * @param callback - Function called for each notebook with its UUID and parent UUIDs
 */
export function walkThroughNotebookHierarchty(
  libraryMeta: QvLibraryMeta,
  parents: string[],
  callback: (notebookName: string, parents: string[]) => void,
): void {
  callback(libraryMeta.uuid, parents);
  if (libraryMeta.children && libraryMeta.children.length > 0) {
    const p = [...parents, libraryMeta.uuid];
    libraryMeta.children?.forEach((meta) => {
      walkThroughNotebookHierarchty(meta, p, callback);
    });
  }
}
