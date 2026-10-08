import ast
import copy
import hashlib
import json
import pathlib
import sys
from types import CodeType

VERSION = "python-ast-1"
BODIES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)
UNIT_DECISIONS = (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler)
SETUP_NAMES = {"setUp", "tearDown", "setUpClass", "tearDownClass", "setup", "teardown", "setup_method", "teardown_method", "setup_class", "teardown_class", "setup_module", "teardown_module", "setup_function", "teardown_function"}


def qualified_reference(node, imports):
    if isinstance(node, ast.Call):
        return qualified_reference(node.func, imports)
    if isinstance(node, ast.Attribute):
        return qualified_reference(node.value, imports) + "." + node.attr
    return imports.get(getattr(node, "id", ""), getattr(node, "id", ""))


def imported_names(tree):
    imports = {}
    for node in tree.body:
        imports.update(import_bindings(node))
    return imports


def import_bindings(node):
    if isinstance(node, ast.Import):
        return dict(import_alias(alias, "") for alias in node.names)
    if isinstance(node, ast.ImportFrom):
        return dict(import_alias(alias, str(node.module) + ".") for alias in node.names)
    return {}


def import_alias(alias, module):
    return alias.asname or alias.name, module + alias.name


def class_is_oracle(node, imports):
    return any(qualified_reference(base, imports) == "unittest.TestCase" for base in node.bases)


def fixture_reason(node, filename, imports):
    if pathlib.PurePosixPath(filename).name == "conftest.py":
        return "conftest body"
    decorators = getattr(node, "decorator_list", [])
    if any(qualified_reference(decorator, imports) == "pytest.fixture" for decorator in decorators):
        return "pytest fixture decorator"
    return ""


def oracle_role(node, filename, owner, imports):
    fixture = fixture_reason(node, filename, imports)
    if fixture:
        return "fixture-setup", fixture
    name = getattr(node, "name", "")
    basename = pathlib.PurePosixPath(filename).name
    test_file = basename.startswith("test_") or basename.endswith("_test.py")
    if name in SETUP_NAMES and any([test_file, owner[1]]):
        return "fixture-setup", "test setup/teardown name"
    return qualified_oracle(name, test_file, owner)


def qualified_oracle(name, test_file, owner):
    if owner[1]:
        return "oracle", "method of source-resolved unittest.TestCase subclass"
    if not test_file:
        return "production", "no source-qualified oracle or fixture/setup marker"
    if owner[0].startswith("Test"):
        return "oracle", "Test* class method in a test module"
    if name.startswith("test_"):
        return "oracle", "test_* function in test_*.py or *_test.py"
    return "production", "no source-qualified oracle or fixture/setup marker"


class OwnedBody(ast.NodeTransformer):
    def visit(self, node):
        if isinstance(node, BODIES):
            return ast.copy_location(ast.Name(id=getattr(node, "name", "<lambda>"), ctx=ast.Load()), node)
        return super().visit(node)


def owned_nodes(node):
    body = node.body if isinstance(node.body, list) else [node.body]
    return [OwnedBody().visit(copy.deepcopy(statement)) for statement in body]


def decision_count(node):
    if isinstance(node, UNIT_DECISIONS):
        return 1
    if isinstance(node, ast.BoolOp):
        return len(node.values) - 1
    if isinstance(node, ast.comprehension):
        return 1 + len(node.ifs)
    if isinstance(node, ast.match_case):
        return int(not wildcard_pattern(node.pattern)) + int(node.guard is not None)
    return 0


def wildcard_pattern(pattern):
    return isinstance(pattern, ast.MatchAs) and pattern.pattern is None


def body_name(node, parent):
    if not isinstance(node, ast.Lambda):
        return node.name
    if isinstance(parent, ast.Assign):
        return ast.unparse(parent.targets[0]) + ".<lambda>"
    if isinstance(parent, ast.AnnAssign):
        return ast.unparse(parent.target) + ".<lambda>"
    return "<lambda>"


def body_nodes(statements):
    return [child for statement in statements for child in ast.walk(statement)]


def owned_line_numbers(nodes):
    return sorted({child.lineno for child in nodes if hasattr(child, "lineno")})


def descriptor(node, name, identity, parent, role, reason):
    statements = owned_nodes(node)
    nodes = body_nodes(statements)
    assertions = sum(isinstance(child, ast.Assert) for child in nodes)
    decisions = sum(decision_count(child) for child in nodes)
    definition = copy.deepcopy(node)
    definition.body = statements if isinstance(node.body, list) else statements[0]
    fingerprint = ast.dump(definition, include_attributes=False)
    return {
        "identity": identity, "parent": parent, "name": name,
        "line": node.lineno, "endLine": node.end_lineno,
        "ownedLines": owned_line_numbers(nodes),
        "complexity": 1 + decisions + assertions * int(role != "oracle"),
        "decisions": decisions, "assertionStatements": assertions,
        "oracleClassification": role, "oracleReason": reason,
        "fingerprint": hashlib.sha256((fingerprint + role).encode()).hexdigest(),
        "source": "python-ast", "adapterVersion": VERSION,
    }


def executable_line_numbers(code):
    lines = {line for _, _, line in code.co_lines() if line}
    for constant in code.co_consts:
        if isinstance(constant, CodeType):
            lines.update(executable_line_numbers(constant))
    return lines


class BodyCollector:
    def __init__(self, tree, filename):
        self.filename = filename
        self.imports = imported_names(tree)
        self.executable_lines = executable_line_numbers(compile(tree, filename, "exec", dont_inherit=True, optimize=0))
        self.rows = []
        self.ordinals = {}

    def add_body(self, node, parent_node, names, parent, owner):
        local_name = body_name(node, parent_node)
        name = ".".join(names + [local_name])
        key = (parent, type(node).__name__, name)
        ordinal = self.ordinals.get(key, 0)
        self.ordinals[key] = ordinal + 1
        identity = parent + "/" + type(node).__name__ + ":" + name + "#" + str(ordinal)
        role, reason = oracle_role(node, self.filename, owner, self.imports)
        row = descriptor(node, name, identity, parent, role, reason)
        row["executableLines"] = sorted(set(row["ownedLines"]) & self.executable_lines)
        self.rows.append(row)
        for child in ast.iter_child_nodes(node):
            self.walk(child, node, names + [local_name], identity, ("", False))

    def walk(self, node, parent_node, names, parent, owner):
        if isinstance(node, BODIES):
            self.add_body(node, parent_node, names, parent, owner)
            return
        if isinstance(node, ast.ClassDef):
            names = names + [node.name]
            owner = (node.name, class_is_oracle(node, self.imports))
        for child in ast.iter_child_nodes(node):
            self.walk(child, node, names, parent, owner)


def analyze(text, filename):
    tree = ast.parse(text, filename=filename)
    collector = BodyCollector(tree, filename)
    collector.walk(tree, None, [], "<root>", ("", False))
    return {"adapterVersion": VERSION, "rows": collector.rows}


def main():
    request = json.load(sys.stdin)
    print(json.dumps(analyze(request["text"], request["file"])))


if __name__ == "__main__":
    main()
