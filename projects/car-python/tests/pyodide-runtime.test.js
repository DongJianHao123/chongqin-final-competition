const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const { loadPyodide } = require(path.join(root, "vendor", "pyodide", "pyodide.js"));

test("vendored Pyodide executes the worker program bridge without network access", async () => {
  const runtimeRoot = path.join(root, "vendor", "pyodide") + path.sep;
  const pyodide = await loadPyodide({
    indexURL: runtimeRoot,
    stdLibURL: path.join(runtimeRoot, "python_stdlib.zip")
  });
  assert.equal(pyodide.runPython("sum(range(101))"), 5050);

  const workerSource = fs.readFileSync(path.join(root, "python-worker.js"), "utf8");
  const runtimeMatch = workerSource.match(/const runtime = `([\s\S]*?)`;\s*await pyodide\.runPythonAsync/);
  assert.ok(runtimeMatch, "worker Python runtime template should be extractable");

  const actions = [];
  const output = [];
  pyodide.globals.set("student_source", "robot.forward(25)\nrobot.right_90()\nprint('done')");
  pyodide.globals.set("js_robot", {
    forward: async distanceCm => actions.push(["forward", Number(distanceCm)]),
    right_90: async () => actions.push(["right_90"])
  });
  pyodide.globals.set("emit_output", value => output.push(String(value)));
  await pyodide.runPythonAsync(runtimeMatch[1], { filename: "<worker-smoke>" });

  assert.deepEqual(actions, [["forward", 25], ["right_90"]]);
  assert.equal(output.length, 1);
  assert.equal(output[0].startsWith("done"), true);

  actions.length = 0;
  output.length = 0;
  pyodide.globals.set("student_source", [
    "class a:",
    "    def __init__(self):",
    "        print(114)",
    "x = a()"
  ].join("\n"));
  await pyodide.runPythonAsync(runtimeMatch[1], { filename: "<worker-class-constructor>" });

  assert.deepEqual(actions, []);
  assert.deepEqual(output, ["114\\n"]);
});
