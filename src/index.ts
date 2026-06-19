#!/usr/bin/env node
/**
 * MCP Server for Fantastical Calendar
 *
 * Provides calendar management through Fantastical's AppleScript interface.
 * Leverages Fantastical's powerful natural language parsing for event creation.
 *
 * Requirements:
 * - macOS only
 * - Fantastical installed
 * - Accessibility permissions for osascript
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The helper lives inside an ad-hoc-signed .app bundle and is launched via
// `open -W` so LaunchServices detaches it from node's attribution chain.
// Without this, TCC sees an unsigned node (from nvm/Homebrew) as the
// "responsible" process in the chain and auto-denies Calendar access without
// ever prompting the user. See issue #6 for full diagnosis.
const HELPER_APP_PATH = join(__dirname, "native", "FantasticalHelper.app");

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runNativeHelper(command: string, arg?: string): Promise<string | null> {
  // Create a per-invocation temp directory for the JSON output, so concurrent
  // calls can't collide and we always clean up.
  const workDir = mkdtempSync(join(tmpdir(), "mcp-fantastical-"));
  const outputPath = join(workDir, "result.json");

  try {
    const helperArgs = [command];
    if (arg) helperArgs.push(arg);
    helperArgs.push("--output", outputPath);

    const quotedArgs = helperArgs.map(shellQuote).join(" ");
    // `open -W` waits for the launched app to exit. `-n` forces a new instance
    // (needed because each MCP call is independent). `-g` keeps it in the
    // background so no dock icon flashes even though LSUIElement is set.
    const cmd = `/usr/bin/open -W -n -g -a ${shellQuote(HELPER_APP_PATH)} --args ${quotedArgs}`;

    // 30s timeout leaves headroom for the one-time TCC prompt on first run.
    await execAsync(cmd, { timeout: 30000 });

    return readFileSync(outputPath, "utf8").trim();
  } catch (err) {
    console.error("[mcp-fantastical] native helper failed:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
}

// Helper to run AppleScript
async function runAppleScript(script: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    if (stderr && !stdout) {
      throw new Error(stderr);
    }
    return stdout.trim();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`AppleScript error: ${error.message}`);
    }
    throw error;
  }
}

// Helper to run multi-line AppleScript
async function runAppleScriptMultiline(script: string): Promise<string> {
  try {
    // Write script to temp file and execute
    const escapedScript = script.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const { stdout, stderr } = await execAsync(`osascript -e "${escapedScript}"`);
    if (stderr && !stdout) {
      throw new Error(stderr);
    }
    return stdout.trim();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`AppleScript error: ${error.message}`);
    }
    throw error;
  }
}

// Check if Fantastical is installed
async function checkFantasticalInstalled(): Promise<boolean> {
  try {
    await runAppleScript('tell application "System Events" to return exists (processes where name is "Fantastical")');
    return true;
  } catch {
    return false;
  }
}

const FANTASTICAL_DB_PATH = (process.env.HOME ?? "~") +
  "/Library/Group Containers/85C27NK92C.com.flexibits.fantastical2.mac/Database/Fantastical-8.fcdata";

async function queryFantasticalDB(
  startDayOffset: number,
  numDays: number
): Promise<{ events: any[]; calendars: any[] }> {
  const script = [
    "import sqlite3,plistlib,datetime,json",
    `DB="${FANTASTICAL_DB_PATH}"`,
    "E=datetime.datetime(2001,1,1,tzinfo=datetime.timezone.utc)",
    "conn=sqlite3.connect(f'file:{DB}?mode=ro',uri=True)",
    "cur=conn.cursor()",
    "cn={}",
    "cur.execute(\"SELECT data FROM database2 WHERE collection='calendars'\")",
    "rows=cur.fetchall()",
    "for (d,) in rows:",
    " try:",
    "  p=plistlib.loads(bytes(d));o=p.get('$objects',[])",
    "  t=i=None",
    "  for x in o:",
    "   if isinstance(x,dict):",
    "    if 'title' in x and t is None:",
    "     idx=x['title'];t=o[idx.data] if isinstance(idx,plistlib.UID) else None",
    "    if 'identifier' in x and i is None:",
    "     idx=x['identifier'];i=o[idx.data] if isinstance(idx,plistlib.UID) else None",
    "  if i and t:cn[i]=t",
    " except:pass",
    "def cd(d):",
    " dt=datetime.datetime(d.year,d.month,d.day,tzinfo=datetime.timezone.utc)",
    " return (dt-E).total_seconds()",
    "def ft(ts):",
    " return (E+datetime.timedelta(seconds=ts)).astimezone().strftime('%Y-%m-%dT%H:%M:%S%z')",
    `sd=${startDayOffset};nd=${numDays}`,
    "t=datetime.date.today()",
    "s=t+datetime.timedelta(days=sd)",
    "e=s+datetime.timedelta(days=nd)",
    "cur.execute(\"SELECT si.startDate,si.isAllDayOrFloating,si.calendarIdentifier,fts.title,fts.location FROM secondaryIndex_index_calendarItems si LEFT JOIN fts_fts fts ON si.rowid=fts.rowid WHERE si.startDate>=? AND si.startDate<? AND si.hidden=0 AND (si.completed IS NULL OR si.completed=0) AND fts.title IS NOT NULL AND fts.title!='' ORDER BY si.startDate\",(cd(s),cd(e)))",
    "seen=[];evts=[]",
    "for ts,ad,ci,ti,lo in cur.fetchall():",
    " k=(round(ts),ti)",
    " if k in seen:continue",
    " seen.append(k)",
    " evts.append({'title':ti,'start':'[All Day]' if ad else ft(ts),'allDay':bool(ad),'calendar':cn.get(ci,''),'location':lo or ''})",
    "conn.close()",
    "print(json.dumps({'events':evts,'calendars':[{'name':v,'id':k} for k,v in cn.items()]}))",
  ].join("\n");

  const { stdout } = await execAsync(`python3 << 'PYEOF'\n${script}\nPYEOF`);
  return JSON.parse(stdout.trim());
}

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: "fantastical_create_event",
    description: "Create a calendar event using Fantastical's natural language parsing. Examples: 'Meeting with John tomorrow at 3pm', 'Dentist appointment Friday 10am', 'Call with team every Monday at 9am'",
    inputSchema: {
      type: "object" as const,
      properties: {
        sentence: {
          type: "string",
          description: "Natural language description of the event (e.g., 'Lunch with Sarah tomorrow at noon')",
        },
        calendar: {
          type: "string",
          description: "Optional: Target calendar name (e.g., 'Work', 'Personal')",
        },
        notes: {
          type: "string",
          description: "Optional: Additional notes for the event",
        },
        addImmediately: {
          type: "boolean",
          description: "Add immediately without showing Fantastical UI (default: true)",
        },
      },
      required: ["sentence"],
    },
  },
  {
    name: "fantastical_get_today",
    description: "Get today's calendar events from Fantastical",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fantastical_get_upcoming",
    description: "Get upcoming calendar events from Fantastical",
    inputSchema: {
      type: "object" as const,
      properties: {
        days: {
          type: "number",
          description: "Number of days to look ahead (default: 7)",
        },
      },
      required: [],
    },
  },
  {
    name: "fantastical_show_date",
    description: "Open Fantastical and navigate to a specific date",
    inputSchema: {
      type: "object" as const,
      properties: {
        date: {
          type: "string",
          description: "Date to show (e.g., '2025-01-15', 'tomorrow', 'next monday')",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "fantastical_get_calendars",
    description: "List all available calendars in Fantastical",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "fantastical_search",
    description: "Search for events by text in Fantastical",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (event title, location, or notes)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "fantastical_update_event",
    description: "Update an existing Google Calendar event (title, location, description/notes, start time, end time). First use fantastical_get_today or fantastical_get_upcoming to find the event and get its calendar and title.",
    inputSchema: {
      type: "object" as const,
      properties: {
        calendarId: {
          type: "string",
          description: "Calendar identifier (e.g. 'youngkwangk@gmail.com' or a group calendar ID). Use 'primary' for the main calendar.",
        },
        eventTitle: {
          type: "string",
          description: "Current title of the event to find and update",
        },
        date: {
          type: "string",
          description: "Date of the event in YYYY-MM-DD format, used to narrow the search",
        },
        updates: {
          type: "object",
          description: "Fields to update",
          properties: {
            title: { type: "string", description: "New event title" },
            location: { type: "string", description: "New event location" },
            description: { type: "string", description: "New event description/notes" },
          },
        },
      },
      required: ["calendarId", "eventTitle", "date", "updates"],
    },
  },
];

const GOOGLE_TOKEN_FILE = (process.env.HOME ?? "~") +
  "/.config/opencode/google-calendar-token.json";
const GOOGLE_CREDS_FILE = (process.env.HOME ?? "~") +
  "/.config/opencode/google-calendar-credentials.json";

async function getGoogleCalendarToken(): Promise<string> {
  // Use python3 to get a valid (possibly refreshed) access token
  const script = `
import json, sys
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request

try:
    creds = Credentials.from_authorized_user_file(
        "${GOOGLE_TOKEN_FILE}",
        ["https://www.googleapis.com/auth/calendar"]
    )
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open("${GOOGLE_TOKEN_FILE}", "w") as f:
            f.write(creds.to_json())
    print(creds.token)
except Exception as e:
    print("ERROR:" + str(e), file=sys.stderr)
    sys.exit(1)
`;
  const { stdout } = await execAsync(`python3 << 'PYEOF'\n${script}\nPYEOF`);
  return stdout.trim();
}

async function updateGoogleCalendarEvent(
  calendarId: string,
  eventTitle: string,
  date: string,
  updates: { title?: string; location?: string; description?: string }
): Promise<{ success: boolean; message: string; event?: any }> {
  const token = await getGoogleCalendarToken();

  // Search for the event on the given date
  const timeMin = new Date(`${date}T00:00:00`).toISOString();
  const timeMax = new Date(`${date}T23:59:59`).toISOString();
  const listUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true`;

  const listRes = await execAsync(
    `curl -s -H "Authorization: Bearer ${token}" "${listUrl}"`
  );
  const listData = JSON.parse(listRes.stdout);

  if (listData.error) {
    throw new Error(`Calendar API error: ${listData.error.message}`);
  }

  // Find matching event by title (case-insensitive)
  const event = (listData.items ?? []).find((e: any) =>
    (e.summary ?? "").toLowerCase().includes(eventTitle.toLowerCase())
  );

  if (!event) {
    throw new Error(`Event "${eventTitle}" not found on ${date} in calendar ${calendarId}`);
  }

  // Build patch body
  const patch: any = {};
  if (updates.title) patch.summary = updates.title;
  if (updates.location !== undefined) patch.location = updates.location;
  if (updates.description !== undefined) patch.description = updates.description;

  const patchUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${event.id}`;
  const patchRes = await execAsync(
    `curl -s -X PATCH -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d ${JSON.stringify(JSON.stringify(patch))} "${patchUrl}"`
  );
  const updated = JSON.parse(patchRes.stdout);

  if (updated.error) {
    throw new Error(`Update failed: ${updated.error.message}`);
  }

  return {
    success: true,
    message: `Updated "${updated.summary}" on ${date}`,
    event: {
      id: updated.id,
      title: updated.summary,
      location: updated.location ?? "",
      description: updated.description ?? "",
    },
  };
}

// Create server instance
const server = new Server(
  {
    name: "mcp-fantastical",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "fantastical_create_event": {
        const { sentence, calendar, notes, addImmediately = true } = args as {
          sentence: string;
          calendar?: string;
          notes?: string;
          addImmediately?: boolean;
        };

        // Build URL with parameters using encodeURIComponent instead of
        // URLSearchParams, which encodes spaces as "+" — Fantastical's URL
        // scheme parser does not treat "+" as a space, causing natural language
        // sentences with spaces to be misinterpreted (e.g. timed events
        // created as all-day events).
        const parts: string[] = [];
        parts.push("s=" + encodeURIComponent(sentence));
        if (addImmediately) parts.push("add=1");
        if (calendar) parts.push("calendarName=" + encodeURIComponent(calendar));
        if (notes) parts.push("n=" + encodeURIComponent(notes));

        const url = `x-fantastical3://parse?${parts.join("&")}`;
        const script = `do shell script "open '${url}'"`;

        await runAppleScript(script);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Event created: "${sentence}"`,
              calendar: calendar || "default",
              addedImmediately: addImmediately,
            }, null, 2),
          }],
        };
      }

      case "fantastical_get_today": {
        const data = await queryFantasticalDB(0, 1);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              date: new Date().toLocaleDateString("en-CA"),
              count: data.events.length,
              events: data.events,
            }, null, 2),
          }],
        };
      }

      case "fantastical_get_upcoming": {
        const { days = 7 } = args as { days?: number };
        const data = await queryFantasticalDB(0, days);
        const today = new Date();
        const endDate = new Date(today);
        endDate.setDate(endDate.getDate() + days);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              range: {
                start: today.toLocaleDateString("en-CA"),
                end: endDate.toLocaleDateString("en-CA"),
                days,
              },
              count: data.events.length,
              events: data.events,
            }, null, 2),
          }],
        };
      }

      case "fantastical_show_date": {
        const { date } = args as { date: string };

        // Use URL scheme to show date in Fantastical
        const script = `do shell script "open 'x-fantastical3://show/calendar/${encodeURIComponent(date)}'"`;
        await runAppleScript(script);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Opened Fantastical to date: ${date}`,
            }, null, 2),
          }],
        };
      }

      case "fantastical_get_calendars": {
        const data = await queryFantasticalDB(0, 0);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: data.calendars.length,
              calendars: data.calendars,
            }, null, 2),
          }],
        };
      }

      case "fantastical_search": {
        const { query } = args as { query: string };

        // Search using URL scheme which opens Fantastical's search
        const script = `do shell script "open 'x-fantastical3://search?query=${encodeURIComponent(query)}'"`;
        await runAppleScript(script);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: `Opened Fantastical search for: "${query}"`,
            }, null, 2),
          }],
        };
      }

      case "fantastical_update_event": {
        const { calendarId, eventTitle, date, updates } = args as {
          calendarId: string;
          eventTitle: string;
          date: string;
          updates: { title?: string; location?: string; description?: string };
        };

        const result = await updateGoogleCalendarEvent(calendarId, eventTitle, date, updates);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start the server
async function main() {
  // Check if on macOS
  if (process.platform !== "darwin") {
    console.error("Error: This MCP server only works on macOS (Fantastical is macOS-only)");
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Fantastical MCP server running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
