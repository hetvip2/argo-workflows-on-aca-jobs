import console from "node:console";
import http from "node:http";
import { URL } from "node:url";

const executions = new Map();
let sequence = 0;

const send = (response, status, body) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};

http
  .createServer((request, response) => {
    const url = new URL(request.url, "http://arm-stub");
    const jobMatch = url.pathname.match(
      /\/jobs\/([^/]+)\/(start|executions\/([^/]+))$/,
    );
    if (!jobMatch) {
      send(response, 404, {});
      return;
    }
    const jobName = decodeURIComponent(jobMatch[1]);
    const correlationId = request.headers["x-ms-client-request-id"];
    if (request.method === "POST" && jobMatch[2] === "start") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const executionName = `local-${++sequence}`;
        executions.set(executionName, {
          correlationId,
          jobName,
          polls: 0,
          request: JSON.parse(body || "{}"),
        });
        console.log(
          JSON.stringify({
            event: "start",
            executionName,
            correlationId,
            jobName,
          }),
        );
        send(response, 200, { name: executionName });
      });
      return;
    }
    if (request.method === "GET" && jobMatch[3]) {
      const executionName = decodeURIComponent(jobMatch[3]);
      const execution = executions.get(executionName);
      if (!execution) {
        send(response, 404, {});
        return;
      }
      execution.polls += 1;
      const status =
        execution.polls === 1
          ? "Running"
          : execution.jobName === "terminal-failure"
            ? "Failed"
            : "Succeeded";
      console.log(
        JSON.stringify({
          event: "poll",
          executionName,
          correlationId: execution.correlationId,
          status,
        }),
      );
      send(response, 200, { properties: { status } });
      return;
    }
    send(response, 405, {});
  })
  .listen(8080, "0.0.0.0", () => console.log("ARM stub listening on 8080"));
