/**
 * Represents a complete Quiver library.
 */
export interface QvLibrary {
  /** Library metadata including hierarchy structure */
  meta: QvLibraryMeta;
  /** All notebooks in the library (both in hierarchy and standalone) */
  notebooks: QvNotebook[];
}

/**
 * Library metadata defining the notebook hierarchy.
 * Forms a tree structure where each node can have child notebooks.
 */
export interface QvLibraryMeta {
  /** UUID of this notebook in the hierarchy */
  uuid: string;
  /** Child notebooks in the hierarchy */
  children?: QvLibraryMeta[];
}

/**
 * Represents a Quiver notebook containing notes.
 */
export interface QvNotebook {
  /** All notes contained in this notebook */
  notes: QvNote[];
  /** Notebook metadata */
  meta: QvNotebookMeta;
}

/**
 * Metadata for a notebook.
 */
export interface QvNotebookMeta {
  /** Display name of the notebook */
  name: string;
  /** Unique identifier for the notebook */
  uuid: string;
}

/**
 * Represents a single Quiver note.
 */
export interface QvNote {
  /** Absolute path to the .qvnote directory */
  notePath: string;
  /** Path to the content.json file */
  contentPath: string;
  /** Note metadata */
  meta: QvNoteMeta;
  /** Resource files attached to this note */
  resources?: QvNoteResource;
}

/**
 * Metadata for a note.
 */
export interface QvNoteMeta {
  /** Title of the note */
  title: string;
  /** Unique identifier for the note */
  uuid: string;
  /** Creation timestamp (Unix timestamp in seconds) */
  created_at: number;
  /** Last update timestamp (Unix timestamp in seconds) */
  updated_at: number;
  /** Tags associated with the note */
  tags: string[];
}

/**
 * Types of content cells supported in Quiver notes.
 */
export enum CellType {
  /** Code block with syntax highlighting */
  CodeCell = 'code',
  /** Rich text/HTML content */
  TextCell = 'text',
  /** Markdown content */
  MarkdownCell = 'markdown',
  /** LaTeX mathematical expressions */
  LatexCell = 'latex',
  /** Diagram definitions (flowchart or sequence) */
  DiagramCell = 'diagram',
}

/**
 * A single cell of content within a note.
 */
export interface Cell {
  /** The type of content this cell contains */
  type: CellType;
  /** Programming language for code cells */
  language?: string;
  /** Type of diagram ('flow' or 'sequence') for diagram cells */
  diagramType?: string;
  /** The actual content of the cell */
  data: string;
}

/**
 * The content of a Quiver note.
 */
export interface QvNoteContent {
  /** Array of content cells in order */
  cells: Cell[];
  /** Title of the note */
  title: string;
}

/**
 * Collection of resource files attached to a note.
 */
export interface QvNoteResource {
  /** Array of resource files */
  files: QvNoteResourceFile[];
}

/**
 * A single resource file (image, attachment, etc.).
 */
export interface QvNoteResourceFile {
  /** Filename of the resource */
  name: string;
}
