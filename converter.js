#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const { create } = require('xmlbuilder2');
const cheerio = require('cheerio');
const { graphlib, layout } = require('dagre');
const { program } = require('commander');

async function runConversion(inputFile, outputFile) {
    if (!fs.existsSync(inputFile)) {
        console.error("Error: Input file does not exist.");
        process.exit(1);
    }

    console.log("🚀 Reading Mermaid file...");

    // Read the Mermaid file
    const mermaidContent = fs.readFileSync(inputFile, 'utf8');

    console.log("📊 Parsing Mermaid syntax and computing Dagre layout...");

    // Parse Mermaid and create Dagre layout
    const { nodes, edges } = parseMermaidAndLayout(mermaidContent);

    console.log(`✅ Parsed ${nodes.length} nodes and ${edges.length} edges`);

    // Apply professional styling to nodes
    nodes.forEach(node => {
        let style = "whiteSpace=wrap;html=1;fontSize=12;fillColor=#ffffff;strokeColor=#000000;rounded=1;";
        if (node.shape === 'diamond') {
            // FIX: Add 'perimeter=rhombusPerimeter' so arrows touch the angled edges properly
            style = "shape=rhombus;perimeter=rhombusPerimeter;whiteSpace=wrap;html=1;fontSize=12;";
        } else if (node.shape === 'round') {
            style = "shape=ellipse;perimeter=ellipsePerimeter;whiteSpace=wrap;html=1;";
        }
        node.style = style;
    });

    // Auto-add Start and End nodes if not present
    const hasStartNode = nodes.some(n => n.label.toLowerCase().includes('start'));
    const hasEndNode = nodes.some(n => n.label.toLowerCase().includes('end'));

    if (!hasStartNode) {
        // Find the node with no incoming edges (potential start)
        const nodesWithIncoming = new Set(edges.map(e => e.target));
        const potentialStarts = nodes.filter(n => !nodesWithIncoming.has(n.id));

        if (potentialStarts.length > 0) {
            const startNode = potentialStarts[0];
            const autoStart = {
                id: 'auto_start',
                x: startNode.x,
                y: startNode.y - 120,
                w: 100,
                h: 50,
                label: 'Start',
                style: "whiteSpace=wrap;html=1;fontSize=12;fillColor=#ffffff;strokeColor=#000000;"
            };
            nodes.unshift(autoStart);

            // Add edge from Start to the original start node
            edges.unshift({
                id: 'auto_start_edge',
                source: 'auto_start',
                target: startNode.id,
                points: [
                    { x: autoStart.x + autoStart.w/2, y: autoStart.y + autoStart.h },
                    { x: autoStart.x + autoStart.w/2, y: startNode.y }
                ],
                style: "edgeStyle=orthogonalEdgeStyle;rounded=1;curved=1;html=1;endArrow=classic;strokeWidth=2;"
            });
        }
    }

    if (!hasEndNode) {
        // Find the node with no outgoing edges (potential end)
        const nodesWithOutgoing = new Set(edges.map(e => e.source));
        const potentialEnds = nodes.filter(n => !nodesWithOutgoing.has(n.id));

        if (potentialEnds.length > 0) {
            const endNode = potentialEnds[potentialEnds.length - 1];
            const autoEnd = {
                id: 'auto_end',
                x: endNode.x,
                y: endNode.y + endNode.h + 60,
                w: 100,
                h: 50,
                label: 'End',
                style: "whiteSpace=wrap;html=1;fontSize=12;fillColor=#ffffff;strokeColor=#000000;"
            };
            nodes.push(autoEnd);

            // Add edge from the original end node to End
            edges.push({
                id: 'auto_end_edge',
                source: endNode.id,
                target: 'auto_end',
                points: [
                    { x: endNode.x + endNode.w/2, y: endNode.y + endNode.h },
                    { x: endNode.x + endNode.w/2, y: autoEnd.y }
                ],
                style: "edgeStyle=orthogonalEdgeStyle;rounded=1;curved=1;html=1;endArrow=classic;strokeWidth=2;"
            });
        }
    }

    console.log(`📝 Final diagram: ${nodes.length} nodes and ${edges.length} edges (auto-added start/end if needed)`);
    const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('mxGraphModel').ele('root');
    root.ele('mxCell', { id: '0' });
    root.ele('mxCell', { id: '1', parent: '0' });

    // Add nodes
    nodes.forEach(n => {
        root.ele('mxCell', {
            id: n.id,
            value: n.label,
            style: n.style,
            vertex: "1",
            parent: "1"
        }).ele('mxGeometry', {
            x: n.x,
            y: n.y,
            width: n.w,
            height: n.h,
            as: "geometry"
        });
    });

    // Add edges
    edges.forEach(e => {
        const edgeCell = root.ele('mxCell', {
            id: e.id,
            style: e.style,
            edge: "1",
            parent: "1",
            source: e.source,
            target: e.target
        });

        const geo = edgeCell.ele('mxGeometry', { relative: "1", as: "geometry" });
        const array = geo.ele('Array', { as: "points" });

        // FIX: Only add intermediate waypoints.
        // We trust Draw.io to connect the start/end points to the perimeter automatically.
        if (e.points && e.points.length > 2) {
            // Skip the first and last points, let Draw.io span the gap to the anchor
            for (let i = 1; i < e.points.length - 1; i++) {
                array.ele('mxPoint', { x: e.points[i].x, y: e.points[i].y });
            }
        }
    });

    // Write output
    fs.writeFileSync(outputFile, root.end({ prettyPrint: true }));

    console.log(`✅ Success! Diagram converted and saved to: ${outputFile}`);
}

function parseMermaidAndLayout(mermaidText) {
    // Parse Mermaid flowchart syntax
    const lines = mermaidText.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('graph'));

    const nodes = new Map();
    const edges = [];

    // First pass: extract nodes
    lines.forEach(line => {
        // Match node definitions like A[Label] or B{Decision}
        const nodeMatches = line.match(/(\w+)\[([^\]]+)\]|\w+\{([^}]+)\}|\w+\(([^)]+)\)/g);
        if (nodeMatches) {
            nodeMatches.forEach(match => {
                const nodeMatch = match.match(/(\w+)(?:\[([^\]]+)\]|\{([^}]+)\}|\(([^)]+)\))/);
                if (nodeMatch) {
                    const [_, id, rectLabel, diamondLabel, roundLabel] = nodeMatch;
                    const label = rectLabel || diamondLabel || roundLabel || id;
                    const shape = diamondLabel ? 'diamond' : roundLabel ? 'round' : 'rect';

                    if (!nodes.has(id)) {
                        nodes.set(id, {
                            id,
                            label,
                            shape,
                            // Slightly larger dimensions for diamonds to prevent text overflow
                            width: shape === 'diamond' ? 160 : 140,
                            height: shape === 'diamond' ? 100 : 70
                        });
                    }
                }
            });
        }
    });

    // Second pass: extract edges
    lines.forEach(line => {
        // Match edges like A --> B or A -->|Label| B
        const edgeMatches = line.match(/(\w+)\s*-->(?:\s*\|\s*([^|]+)\s*\|\s*)?\s*(\w+)/g);
        if (edgeMatches) {
            edgeMatches.forEach(match => {
                const edgeMatch = match.match(/(\w+)\s*-->(?:\s*\|\s*([^|]+)\s*\|\s*)?\s*(\w+)/);
                if (edgeMatch) {
                    const [_, source, label, target] = edgeMatch;
                    edges.push({
                        source,
                        target,
                        label: label || ''
                    });
                }
            });
        }
    });

    // Dagre Layout Setup
    const g = new graphlib.Graph();
    g.setGraph({
        rankdir: 'TB',
        nodesep: 60,  // Increased separation to give arrows more room
        ranksep: 60,
        edgesep: 20,
        align: 'UL'
    });
    g.setDefaultEdgeLabel(() => ({}));

    // Add nodes to Dagre graph
    nodes.forEach(node => {
        g.setNode(node.id, {
            label: node.label,
            width: node.width,
            height: node.height,
            shape: node.shape
        });
    });

    // Add edges to Dagre graph
    edges.forEach(edge => {
        g.setEdge(edge.source, edge.target);
    });

    // Apply layout
    layout(g);

    // Extract positioned nodes
    const positionedNodes = [];
    g.nodes().forEach(nodeId => {
        const node = g.node(nodeId);
        const originalNode = nodes.get(nodeId);
        positionedNodes.push({
            id: nodeId,
            label: node.label,
            x: node.x - node.width / 2, // Center the node
            y: node.y - node.height / 2,
            w: node.width,
            h: node.height,
            shape: originalNode.shape
        });
    });

    // Extract edges with waypoints
    const positionedEdges = [];
    g.edges().forEach((edge, i) => {
        const points = g.edge(edge).points || [];
        
        // FIX: Removed all the 'getDiamondConnectionPoint' logic.
        // We just pass the raw Dagre path. Draw.io will handle the anchors.

        positionedEdges.push({
            id: `edge_${i}`,
            source: edge.v,
            target: edge.w,
            points: points,
            style: "edgeStyle=orthogonalEdgeStyle;rounded=1;curved=1;html=1;endArrow=classic;strokeWidth=2;"
        });
    });

    return { nodes: positionedNodes, edges: positionedEdges };
}

program
    .requiredOption('-i, --input <file>', 'Input .mmd')
    .requiredOption('-o, --output <file>', 'Output .drawio')
    .action((options) => runConversion(options.input, options.output));

program.parse();

program.parse();