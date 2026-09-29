const PYODIDE_INDEX_URL = new URL("./vendor/pyodide/", self.location.href).href;
let pyodide;
let nextRequestId = 0;
const pendingRequests = new Map();

function requestRobot(method, args = []) {
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    postMessage({ type: "robot", id, method, args });
  });
}

function emitOutput(text) {
  postMessage({ type: "output", text: String(text) });
}

async function preparePython() {
  // The complete runtime is vendored so a competition run does not depend on
  // a third-party CDN or OSS endpoint being available.
  importScripts(`${PYODIDE_INDEX_URL}pyodide.js`);
  postMessage({ type: "progress", stage: "script" });
  importScripts(`${PYODIDE_INDEX_URL}pyodide.asm.js`);
  postMessage({ type: "progress", stage: "runtime" });
  pyodide = await loadPyodide({
    indexURL: PYODIDE_INDEX_URL,
    stdLibURL: `${PYODIDE_INDEX_URL}python_stdlib.zip`
  });
  pyodide.globals.set("js_robot", {
    forward: distanceCm => requestRobot("forward", [distanceCm]),
    backward: distanceCm => requestRobot("backward", [distanceCm]),
    left: seconds => requestRobot("left", [seconds]),
    right: seconds => requestRobot("right", [seconds]),
    left_90: () => requestRobot("left_90"),
    right_90: () => requestRobot("right_90"),
    left_angle: degrees => requestRobot("left_angle", [degrees]),
    right_angle: degrees => requestRobot("right_angle", [degrees]),
    wait: seconds => requestRobot("wait", [seconds]),
    grab: () => requestRobot("grab"),
    release: () => requestRobot("release"),
    holding: () => requestRobot("holding", []),
    odometry: () => requestRobot("odometry", []),
    road_state: () => requestRobot("road_state", []),
    map_graph: () => requestRobot("map_graph", []),
    mission: () => requestRobot("mission", []),
    task_state: () => requestRobot("task_state", []),
    release_preview: () => requestRobot("release_preview", []),
    follow_road: (maxCm, speed, obeySpeedLimit) => requestRobot("follow_road", [maxCm, speed, obeySpeedLimit]),
    take_exit: (roadId, speed, obeySpeedLimit) => requestRobot("take_exit", [roadId, speed, obeySpeedLimit]),
    sees: (target, confidence) => requestRobot("sees", [target, confidence]),
    count: (target, confidence) => requestRobot("count", [target, confidence]),
    detect: (target, confidence) => requestRobot("detect", [target, confidence]),
    near: (target, confidence) => requestRobot("near", [target, confidence]),
    centered: (target, confidence) => requestRobot("centered", [target, confidence]),
    direction: (target, confidence) => requestRobot("direction", [target, confidence]),
    distance_to: (target, confidence) => requestRobot("distance_to", [target, confidence]),
    observe: (category, confidence) => requestRobot("observe", [category ?? null, confidence]),
    approach: (target, distanceCm, maxSteps) => requestRobot("approach", [target, distanceCm, maxSteps])
  });
  pyodide.globals.set("emit_output", emitOutput);
  postMessage({ type: "ready" });
}

async function runProgram(source) {
  pyodide.globals.set("student_source", source);
  const runtime = `
import ast
import json
import math

class Robot:
    def _seconds(self, seconds):
        if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
            raise TypeError('\u52a8\u4f5c\u65f6\u95f4\u5fc5\u987b\u586b\u5199\u6570\u5b57\uff0c\u4f8b\u5982 robot.wait(1)')
        seconds = float(seconds)
        if not math.isfinite(seconds) or seconds <= 0 or seconds > 500:
            raise ValueError('\u52a8\u4f5c\u65f6\u95f4\u5fc5\u987b\u5927\u4e8e 0 \u79d2\u4e14\u4e0d\u8d85\u8fc7 500 \u79d2')
        return seconds
    def _centimeters(self, distance_cm):
        if not isinstance(distance_cm, (int, float)) or isinstance(distance_cm, bool):
            raise TypeError('\u884c\u9a76\u8ddd\u79bb\u5fc5\u987b\u586b\u5199\u6570\u5b57\uff0c\u4f8b\u5982 robot.forward(50)')
        distance_cm = float(distance_cm)
        if not math.isfinite(distance_cm) or distance_cm < 0.1 or distance_cm > 500:
            raise ValueError('\u884c\u9a76\u8ddd\u79bb\u5fc5\u987b\u5728 0.1 \u5230 500 \u5398\u7c73\u4e4b\u95f4')
        return distance_cm
    def _confidence(self, confidence):
        if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
            raise TypeError('\u7f6e\u4fe1\u5ea6\u5fc5\u987b\u662f 0 \u5230 1 \u4e4b\u95f4\u7684\u6570\u5b57')
        confidence = float(confidence)
        if not math.isfinite(confidence) or confidence < 0 or confidence > 1:
            raise ValueError('\u7f6e\u4fe1\u5ea6\u5fc5\u987b\u662f 0 \u5230 1 \u4e4b\u95f4\u7684\u6570\u5b57')
        return confidence
    def _degrees(self, degrees):
        if not isinstance(degrees, (int, float)) or isinstance(degrees, bool):
            raise TypeError('\u8f6c\u5411\u89d2\u5ea6\u5fc5\u987b\u586b\u5199\u6570\u5b57\uff0c\u4f8b\u5982 robot.left_angle(45)')
        degrees = float(degrees)
        if not math.isfinite(degrees) or degrees < 1 or degrees > 360:
            raise ValueError('\u8f6c\u5411\u89d2\u5ea6\u5fc5\u987b\u662f 1 \u5230 360 \u5ea6\u4e4b\u95f4\u7684\u6709\u9650\u6570\u5b57')
        return degrees
    def _speed(self, speed):
        if not isinstance(speed, (int, float)) or isinstance(speed, bool):
            raise TypeError('\u901f\u5ea6\u5fc5\u987b\u586b\u5199 10 \u5230 100 \u4e4b\u95f4\u7684\u6570\u5b57')
        speed = float(speed)
        if not math.isfinite(speed) or speed < 10 or speed > 100:
            raise ValueError('\u901f\u5ea6\u5fc5\u987b\u5728 10 \u5230 100 \u4e4b\u95f4')
        return speed
    def _follow_distance(self, max_cm):
        if not isinstance(max_cm, (int, float)) or isinstance(max_cm, bool):
            raise TypeError('\u6700\u5927\u8ddf\u968f\u8ddd\u79bb\u5fc5\u987b\u662f 10 \u5230 500 \u5398\u7c73\u4e4b\u95f4\u7684\u6570\u5b57')
        max_cm = float(max_cm)
        if not math.isfinite(max_cm) or max_cm < 10 or max_cm > 500:
            raise ValueError('\u6700\u5927\u8ddf\u968f\u8ddd\u79bb\u5fc5\u987b\u5728 10 \u5230 500 \u5398\u7c73\u4e4b\u95f4')
        return max_cm
    def _road_id(self, road_id):
        if not isinstance(road_id, str):
            raise TypeError('\u9053\u8def\u7f16\u53f7\u5fc5\u987b\u662f 1 \u5230 128 \u4e2a\u53ef\u6253\u5370\u5b57\u7b26')
        road_id = road_id.strip()
        has_control = any(ord(character) < 32 or 127 <= ord(character) <= 159 for character in road_id)
        if not road_id or len(road_id) > 128 or has_control:
            raise ValueError('\u9053\u8def\u7f16\u53f7\u5fc5\u987b\u662f 1 \u5230 128 \u4e2a\u53ef\u6253\u5370\u5b57\u7b26')
        return road_id
    def _boolean(self, value, label):
        if not isinstance(value, bool):
            raise TypeError(label + '\u5fc5\u987b\u662f True \u6216 False')
        return value
    def _target_name(self, target):
        if not isinstance(target, str) or not target.strip():
            raise ValueError('\u76ee\u6807\u540d\u79f0\u5fc5\u987b\u662f\u975e\u7a7a\u6587\u5b57\uff0c\u4f8b\u5982 robot.approach("\u76ee\u6807\u7269", 100)')
        return target.strip()
    def _category(self, category):
        if category is None:
            return None
        if not isinstance(category, str) or not category.strip():
            raise ValueError('\u89c6\u89c9\u7c7b\u522b\u5fc5\u987b\u662f target\u3001obstacle\u3001distractor\u3001storage-zone \u6216 cleanup-zone')
        normalized = category.strip().lower().replace('_', '-')
        aliases = {
            'target': 'target', '\u76ee\u6807\u7269': 'target',
            'obstacle': 'obstacle', '\u969c\u788d\u7269': 'obstacle', '\u969c\u788d': 'obstacle',
            'distractor': 'distractor', '\u6df7\u6dc6\u7269': 'distractor', '\u5e72\u6270\u7269': 'distractor',
            'storage-zone': 'storage-zone', '\u5b58\u653e\u70b9': 'storage-zone', '\u5b58\u653e\u533a': 'storage-zone',
            'cleanup-zone': 'cleanup-zone', '\u6e05\u7406\u70b9': 'cleanup-zone', '\u6e05\u7406\u533a': 'cleanup-zone'
        }
        if normalized not in aliases:
            raise ValueError('\u4e0d\u652f\u6301\u7684\u89c6\u89c9\u7c7b\u522b\uff1a' + category.strip())
        return aliases[normalized]
    async def forward(self, distance_cm):
        await js_robot.forward(self._centimeters(distance_cm))
        return None
    async def backward(self, distance_cm):
        await js_robot.backward(self._centimeters(distance_cm))
        return None
    async def left(self, seconds):
        await js_robot.left(self._seconds(seconds))
        return None
    async def right(self, seconds):
        await js_robot.right(self._seconds(seconds))
        return None
    async def left_90(self):
        await js_robot.left_90()
        return None
    async def right_90(self):
        await js_robot.right_90()
        return None
    async def left_angle(self, degrees):
        await js_robot.left_angle(self._degrees(degrees))
        return None
    async def right_angle(self, degrees):
        await js_robot.right_angle(self._degrees(degrees))
        return None
    async def wait(self, seconds):
        await js_robot.wait(self._seconds(seconds))
        return None
    async def grab(self):
        await js_robot.grab()
        return None
    async def release(self):
        await js_robot.release()
        return None
    async def holding(self):
        return json.loads(await js_robot.holding())
    async def odometry(self):
        return json.loads(await js_robot.odometry())
    async def road_state(self):
        return json.loads(await js_robot.road_state())
    async def map_graph(self):
        return json.loads(await js_robot.map_graph())
    async def mission(self):
        return json.loads(await js_robot.mission())
    async def task_state(self):
        return json.loads(await js_robot.task_state())
    async def release_preview(self):
        return json.loads(await js_robot.release_preview())
    async def follow_road(self, max_cm=100, speed=40, obey_speed_limit=False):
        return json.loads(await js_robot.follow_road(
            self._follow_distance(max_cm), self._speed(speed),
            self._boolean(obey_speed_limit, '\u81ea\u52a8\u9075\u5b88\u9650\u901f\u9009\u9879')
        ))
    async def take_exit(self, road_id, speed=30, obey_speed_limit=False):
        return json.loads(await js_robot.take_exit(
            self._road_id(road_id), self._speed(speed),
            self._boolean(obey_speed_limit, '出口自动遵守限速选项')
        ))
    async def sees(self, target, confidence=0.6):
        return bool(json.loads(await js_robot.sees(self._target_name(target), self._confidence(confidence))))
    async def count(self, target, confidence=0.6):
        return int(json.loads(await js_robot.count(self._target_name(target), self._confidence(confidence))))
    async def detect(self, target=None, confidence=0.6):
        name = None if target is None else self._target_name(target)
        return json.loads(await js_robot.detect(name, self._confidence(confidence)))
    async def near(self, target, confidence=0.6):
        return bool(json.loads(await js_robot.near(self._target_name(target), self._confidence(confidence))))
    async def centered(self, target, confidence=0.6):
        return bool(json.loads(await js_robot.centered(self._target_name(target), self._confidence(confidence))))
    async def direction(self, target, confidence=0.6):
        return str(json.loads(await js_robot.direction(self._target_name(target), self._confidence(confidence))))
    async def distance_to(self, target, confidence=0.6):
        return json.loads(await js_robot.distance_to(self._target_name(target), self._confidence(confidence)))
    async def observe(self, category=None, confidence=0.6):
        return json.loads(await js_robot.observe(self._category(category), self._confidence(confidence)))
    async def approach(self, target, distance_cm=None, max_steps=60):
        target = self._target_name(target)
        if distance_cm is not None:
            if not isinstance(distance_cm, (int, float)) or isinstance(distance_cm, bool):
                raise TypeError('\u8ddd\u79bb\u5fc5\u987b\u586b\u5199\u6570\u5b57\uff0c\u4f8b\u5982 robot.approach("\u76ee\u6807\u7269", 100)')
            distance_cm = float(distance_cm)
            if not math.isfinite(distance_cm) or distance_cm < 5 or distance_cm > 200:
                raise ValueError('\u9760\u8fd1\u8ddd\u79bb\u5fc5\u987b\u5728 5 \u5230 200 \u5398\u7c73\u4e4b\u95f4')
        if not isinstance(max_steps, int) or isinstance(max_steps, bool) or max_steps < 1 or max_steps > 100:
            raise ValueError('\u6700\u5927\u6b65\u6570\u5fc5\u987b\u662f 1 \u5230 100 \u4e4b\u95f4\u7684\u6574\u6570')
        return bool(json.loads(await js_robot.approach(target, distance_cm, max_steps)))

def student_print(*values, sep=' ', end='\\n'):
    emit_output(sep.join(str(value) for value in values) + end)

class AsyncRobotTransformer(ast.NodeTransformer):
    def __init__(self, function_names):
        self.function_names = function_names
    def visit_ClassDef(self, node):
        # Keep user classes as normal synchronous Python classes. Converting
        # every method to async made __init__ return a coroutine, so even a
        # basic x = A() failed with "__init__() should return None".
        # Robot actions remain available from top-level helper functions,
        # which are the functions this automatic-await transformer supports.
        return node
    def _should_await(self, node):
        is_robot_call = isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name) and node.func.value.id == 'robot'
        is_student_function = isinstance(node.func, ast.Name) and node.func.id in self.function_names
        return is_robot_call or is_student_function
    def visit_FunctionDef(self, node):
        node = self.generic_visit(node)
        return ast.AsyncFunctionDef(
            name=node.name, args=node.args, body=node.body,
            decorator_list=node.decorator_list, returns=node.returns,
            type_comment=node.type_comment, type_params=getattr(node, 'type_params', [])
        )
    def visit_Await(self, node):
        # Explicit await robot... remains valid. Visiting the Call normally
        # would add another Await and then try to await the returned dict/bool.
        if isinstance(node.value, ast.Call) and self._should_await(node.value):
            node.value = self.generic_visit(node.value)
            return node
        return self.generic_visit(node)
    def visit_Call(self, node):
        node = self.generic_visit(node)
        if self._should_await(node):
            return ast.copy_location(ast.Await(value=node), node)
        return node

tree = ast.parse(student_source, filename='<\u5b66\u751f\u4ee3\u7801>', mode='exec')
function_names = {node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}
tree = AsyncRobotTransformer(function_names).visit(tree)
async_main = ast.AsyncFunctionDef(
    name='__student_main__',
    args=ast.arguments(posonlyargs=[], args=[], kwonlyargs=[], kw_defaults=[], defaults=[]),
    body=tree.body or [ast.Pass()], decorator_list=[], returns=None, type_comment=None
)
tree = ast.Module(body=[async_main], type_ignores=[])
tree = ast.fix_missing_locations(tree)
scope = {'robot': Robot(), 'print': student_print, 'js_robot': js_robot}
exec(compile(tree, '<\u5b66\u751f\u4ee3\u7801>', 'exec'), scope, scope)
await scope['__student_main__']()
`;
  await pyodide.runPythonAsync(runtime);
}

onmessage = async event => {
  const message = event.data;
  if (message.type === "robotResult") {
    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    pendingRequests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
    return;
  }
  try {
    if (message.type === "init") return await preparePython();
    if (message.type === "run") {
      await runProgram(message.source);
      postMessage({ type: "done", id: message.id });
    }
  } catch (error) {
    if (message.type === "init") {
      postMessage({ type: "initError", message: error.message || String(error) });
    } else {
      postMessage({ type: "error", id: message.id, message: error.message || String(error) });
    }
  }
};
