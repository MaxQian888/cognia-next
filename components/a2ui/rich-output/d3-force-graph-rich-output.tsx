"use client"

import { memo, useEffect, useRef } from "react"
import * as d3 from "d3"
import { cn } from "@/lib/utils"
import type { A2UIRichOutputGraphEdge, A2UIRichOutputGraphNode } from "@/types/a2ui/schema"

type ForceNode = A2UIRichOutputGraphNode & d3.SimulationNodeDatum
type ForceLink = A2UIRichOutputGraphEdge & d3.SimulationLinkDatum<ForceNode>

function getLinkNodePosition(
  node: ForceLink["source"] | ForceLink["target"],
  axis: "x" | "y"
): number {
  if (!node || typeof node !== "object") {
    return 0
  }

  const resolvedNode = node as { x?: number; y?: number }
  return (axis === "x" ? resolvedNode.x : resolvedNode.y) ?? 0
}

interface D3ForceGraphRichOutputProps {
  nodes: A2UIRichOutputGraphNode[]
  edges: A2UIRichOutputGraphEdge[]
  height?: number
  className?: string
}

export const D3ForceGraphRichOutput = memo(function D3ForceGraphRichOutput({
  nodes,
  edges,
  height = 320,
  className,
}: D3ForceGraphRichOutputProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)

  useEffect(() => {
    const svg = d3.select(svgRef.current)
    svg.selectAll("*").remove()

    const width = 640
    const simulationNodes: ForceNode[] = nodes.map((node) => ({ ...node }))
    const simulationLinks: ForceLink[] = edges.map((edge) => ({ ...edge }))

    const simulation = d3
      .forceSimulation<ForceNode>(simulationNodes)
      .force(
        "link",
        d3
          .forceLink<ForceNode, ForceLink>(simulationLinks)
          .id((d) => d.id)
          .distance(120)
      )
      .force("charge", d3.forceManyBody().strength(-260))
      .force("center", d3.forceCenter(width / 2, height / 2))

    const links = svg
      .append("g")
      .attr("stroke", "#94a3b8")
      .selectAll("line")
      .data(simulationLinks)
      .enter()
      .append("line")
      .attr("stroke-width", 1.5)

    const circles = svg
      .append("g")
      .selectAll("circle")
      .data(simulationNodes)
      .enter()
      .append("circle")
      .attr("r", 18)
      .attr("fill", "#0ea5e9")

    const labels = svg
      .append("g")
      .selectAll("text")
      .data(simulationNodes)
      .enter()
      .append("text")
      .text((d) => d.label)
      .attr("text-anchor", "middle")
      .attr("dy", 4)
      .attr("fill", "#fff")
      .attr("font-size", 11)

    simulation.on("tick", () => {
      links
        .attr("x1", (d) => getLinkNodePosition(d.source, "x"))
        .attr("y1", (d) => getLinkNodePosition(d.source, "y"))
        .attr("x2", (d) => getLinkNodePosition(d.target, "x"))
        .attr("y2", (d) => getLinkNodePosition(d.target, "y"))

      circles.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0)

      labels.attr("x", (d) => d.x ?? 0).attr("y", (d) => d.y ?? 0)
    })

    return () => {
      simulation.stop()
    }
  }, [edges, height, nodes])

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border/60 bg-background/70 p-3",
        className
      )}
    >
      <svg ref={svgRef} width="100%" height={height} viewBox={`0 0 640 ${height}`} />
    </div>
  )
})
