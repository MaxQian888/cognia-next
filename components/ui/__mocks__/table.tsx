import * as React from "react"

// Shared Jest manual mock for `@/components/ui/table`. Each export maps to
// its semantic HTML element so tests can rely on roles (`table`, `row`,
// `columnheader`, `cell`).

type TableProps = React.TableHTMLAttributes<HTMLTableElement> & { children?: React.ReactNode }
type SectionProps = React.HTMLAttributes<HTMLTableSectionElement> & { children?: React.ReactNode }
type RowProps = React.HTMLAttributes<HTMLTableRowElement> & { children?: React.ReactNode }
type CellProps = React.TdHTMLAttributes<HTMLTableCellElement> & { children?: React.ReactNode }
type HeaderCellProps = React.ThHTMLAttributes<HTMLTableCellElement> & { children?: React.ReactNode }
type CaptionProps = React.HTMLAttributes<HTMLTableCaptionElement> & { children?: React.ReactNode }

export function Table({ children, ...rest }: TableProps) {
  return <table {...rest}>{children}</table>
}

export function TableHeader({ children, ...rest }: SectionProps) {
  return <thead {...rest}>{children}</thead>
}

export function TableBody({ children, ...rest }: SectionProps) {
  return <tbody {...rest}>{children}</tbody>
}

export function TableFooter({ children, ...rest }: SectionProps) {
  return <tfoot {...rest}>{children}</tfoot>
}

export function TableRow({ children, ...rest }: RowProps) {
  return <tr {...rest}>{children}</tr>
}

export function TableHead({ children, ...rest }: HeaderCellProps) {
  return <th {...rest}>{children}</th>
}

export function TableCell({ children, ...rest }: CellProps) {
  return <td {...rest}>{children}</td>
}

export function TableCaption({ children, ...rest }: CaptionProps) {
  return <caption {...rest}>{children}</caption>
}
