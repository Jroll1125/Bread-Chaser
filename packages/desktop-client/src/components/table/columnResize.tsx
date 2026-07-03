import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';

import { useLocalPref } from '#hooks/useLocalPref';

// Excel-style column resizing, hybrid with the existing responsive layout: a
// column the user drags becomes a fixed pixel width (persisted per table,
// per device), while untouched columns keep their defaults — usually 'flex',
// so they continue to absorb window resizes. Double-clicking a grip clears
// the override and the column goes back to its default.

const MIN_COLUMN_WIDTH = 48;
const MAX_COLUMN_WIDTH = 2000;

type ColumnWidthsContextValue = {
  widths: Record<string, number>;
  previewColumnWidth: (column: string, px: number) => void;
  commitColumnWidth: (column: string, px: number) => void;
  resetColumnWidth: (column: string) => void;
};

const ColumnWidthsContext = createContext<ColumnWidthsContextValue | null>(
  null,
);

type ColumnWidthsProviderProps = {
  // Stable identifier naming this table in the saved prefs, e.g.
  // 'transactions' or 'mortgage-payments'.
  tableId: string;
  children: ReactNode;
};

export function ColumnWidthsProvider({
  tableId,
  children,
}: ColumnWidthsProviderProps) {
  const [allWidths, setAllWidths] = useLocalPref('tableColumnWidths');
  // Live width during a drag; persisted only on pointer-up so a drag does
  // not write local storage sixty times a second.
  const [preview, setPreview] = useState<Record<string, number>>({});

  const persisted = useMemo(
    () => allWidths?.[tableId] ?? {},
    [allWidths, tableId],
  );
  const widths = useMemo(
    () => ({ ...persisted, ...preview }),
    [persisted, preview],
  );

  // Read through a ref inside the callbacks so drag handlers never hold a
  // stale snapshot of the saved prefs.
  const allWidthsRef = useRef(allWidths);
  allWidthsRef.current = allWidths;

  const previewColumnWidth = useCallback((column: string, px: number) => {
    setPreview(prev => ({ ...prev, [column]: px }));
  }, []);

  const commitColumnWidth = useCallback(
    (column: string, px: number) => {
      const all = allWidthsRef.current ?? {};
      setAllWidths({
        ...all,
        [tableId]: { ...(all[tableId] ?? {}), [column]: px },
      });
      setPreview(prev => {
        const { [column]: _done, ...rest } = prev;
        return rest;
      });
    },
    [setAllWidths, tableId],
  );

  const resetColumnWidth = useCallback(
    (column: string) => {
      const all = allWidthsRef.current ?? {};
      const { [column]: _dropped, ...rest } = all[tableId] ?? {};
      setAllWidths({ ...all, [tableId]: rest });
      setPreview(prev => {
        const { [column]: _done, ...remaining } = prev;
        return remaining;
      });
    },
    [setAllWidths, tableId],
  );

  const value = useMemo(
    () => ({
      widths,
      previewColumnWidth,
      commitColumnWidth,
      resetColumnWidth,
    }),
    [widths, previewColumnWidth, commitColumnWidth, resetColumnWidth],
  );

  return (
    <ColumnWidthsContext.Provider value={value}>
      {children}
    </ColumnWidthsContext.Provider>
  );
}

/**
 * The effective width for a column: the user's pixel override when one
 * exists, else the given default (a number or 'flex'). Safe to call outside
 * a provider — it just returns the default.
 */
export function useColumnWidth(
  column: string,
  defaultWidth: CSSProperties['width'],
): CSSProperties['width'] {
  const context = useContext(ColumnWidthsContext);
  return context?.widths[column] ?? defaultWidth;
}

type ResizableColProps = {
  col: string;
  flex: number;
  grip?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
};

/**
 * A flex table column that honors a drag-resized pixel override: pinned to
 * px when the user resized it, proportional flex otherwise. Header cells
 * pass `grip` to render the drag handle.
 */
export function ResizableCol({
  col,
  flex,
  grip,
  style,
  children,
}: ResizableColProps) {
  const width = useColumnWidth(col, undefined);
  return (
    <View
      style={{
        ...(typeof width === 'number' ? { width, flexShrink: 0 } : { flex }),
        position: 'relative',
        justifyContent: 'center',
        ...style,
      }}
    >
      {children}
      {grip && <ColumnResizeGrip column={col} />}
    </View>
  );
}

type ColumnResizeGripProps = {
  column: string;
};

/**
 * The drag handle on a header cell's right edge. Renders nothing outside a
 * ColumnWidthsProvider, so it can be embedded unconditionally. Drag to set
 * the column's width; double-click to reset it to the default.
 */
export function ColumnResizeGrip({ column }: ColumnResizeGripProps) {
  const context = useContext(ColumnWidthsContext);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(
    null,
  );

  if (!context) {
    return null;
  }
  const { previewColumnWidth, commitColumnWidth, resetColumnWidth } = context;

  const clamp = (px: number) =>
    Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(px)));

  return (
    <View
      onPointerDown={(e: React.PointerEvent<HTMLDivElement>) => {
        // Never let the drag reach the header cell — a header click sorts,
        // and cells expose editors on mouse-down.
        e.preventDefault();
        e.stopPropagation();
        const cell = (e.currentTarget as HTMLDivElement).parentElement;
        if (!cell) {
          return;
        }
        dragState.current = {
          startX: e.clientX,
          startWidth: cell.getBoundingClientRect().width,
        };
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragState.current) {
          return;
        }
        const { startX, startWidth } = dragState.current;
        previewColumnWidth(column, clamp(startWidth + e.clientX - startX));
      }}
      onPointerUp={(e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragState.current) {
          return;
        }
        const { startX, startWidth } = dragState.current;
        dragState.current = null;
        commitColumnWidth(column, clamp(startWidth + e.clientX - startX));
      }}
      onDoubleClick={(e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        resetColumnWidth(column);
      }}
      onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        right: -3,
        width: 7,
        zIndex: 300,
        cursor: 'col-resize',
        ':hover': {
          backgroundColor: theme.tableBorderSelected,
        },
      }}
      aria-hidden
    />
  );
}
