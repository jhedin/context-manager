from mcp.server.fastmcp import FastMCP

# Create a minimal FastMCP server
mcp = FastMCP("Context Visualizer v0")

@mcp.tool()
def show_context_mermaid(reasoning_tokens: int, tool_tokens: int, system_tokens: int) -> str:
    """
    Generates a Mermaid pie chart showing the current session's context distribution.
    Call this tool to visualize context usage.
    """
    # Return a raw markdown string with a mermaid code block
    diagram = f"""
```mermaid
pie title Session Context Usage
    "Reasoning (Agent)" : {reasoning_tokens}
    "Tool I/O (Logs, Files)" : {tool_tokens}
    "System Prompt" : {system_tokens}
```
    """
    return diagram

if __name__ == "__main__":
    mcp.run(transport='stdio')
