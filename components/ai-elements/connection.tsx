import type { ConnectionLineComponentProps } from "@xyflow/react"

const HALF = 0.5

export type ConnectionProps = ConnectionLineComponentProps & {
  stroke?: string
  strokeOpacity?: number
  strokeDasharray?: string
}

export const Connection = ({
  fromX,
  fromY,
  toX,
  toY,
  stroke = "var(--color-ring)",
  strokeOpacity,
  strokeDasharray,
}: ConnectionProps) => (
  <g>
    <path
      className="animated"
      d={`M${fromX},${fromY} C ${fromX + (toX - fromX) * HALF},${fromY} ${fromX + (toX - fromX) * HALF},${toY} ${toX},${toY}`}
      fill="none"
      stroke={stroke}
      strokeDasharray={strokeDasharray}
      strokeOpacity={strokeOpacity}
      strokeWidth={1}
    />
    <circle cx={toX} cy={toY} fill="#fff" r={3} stroke={stroke} strokeWidth={1} />
  </g>
)
