// GENERATED FILE — do not edit.
// Source: lib/plugin/convert/**  ·  Rebuild: pnpm plugin-convert:bundle
// Verified in CI by: pnpm gate:convert-bundle

"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/.pnpm/kind-of@6.0.3/node_modules/kind-of/index.js
var require_kind_of = __commonJS({
  "node_modules/.pnpm/kind-of@6.0.3/node_modules/kind-of/index.js"(exports2, module2) {
    var toString = Object.prototype.toString;
    module2.exports = function kindOf(val) {
      if (val === void 0) return "undefined";
      if (val === null) return "null";
      var type = typeof val;
      if (type === "boolean") return "boolean";
      if (type === "string") return "string";
      if (type === "number") return "number";
      if (type === "symbol") return "symbol";
      if (type === "function") {
        return isGeneratorFn(val) ? "generatorfunction" : "function";
      }
      if (isArray(val)) return "array";
      if (isBuffer(val)) return "buffer";
      if (isArguments(val)) return "arguments";
      if (isDate(val)) return "date";
      if (isError(val)) return "error";
      if (isRegexp(val)) return "regexp";
      switch (ctorName(val)) {
        case "Symbol":
          return "symbol";
        case "Promise":
          return "promise";
        // Set, Map, WeakSet, WeakMap
        case "WeakMap":
          return "weakmap";
        case "WeakSet":
          return "weakset";
        case "Map":
          return "map";
        case "Set":
          return "set";
        // 8-bit typed arrays
        case "Int8Array":
          return "int8array";
        case "Uint8Array":
          return "uint8array";
        case "Uint8ClampedArray":
          return "uint8clampedarray";
        // 16-bit typed arrays
        case "Int16Array":
          return "int16array";
        case "Uint16Array":
          return "uint16array";
        // 32-bit typed arrays
        case "Int32Array":
          return "int32array";
        case "Uint32Array":
          return "uint32array";
        case "Float32Array":
          return "float32array";
        case "Float64Array":
          return "float64array";
      }
      if (isGeneratorObj(val)) {
        return "generator";
      }
      type = toString.call(val);
      switch (type) {
        case "[object Object]":
          return "object";
        // iterators
        case "[object Map Iterator]":
          return "mapiterator";
        case "[object Set Iterator]":
          return "setiterator";
        case "[object String Iterator]":
          return "stringiterator";
        case "[object Array Iterator]":
          return "arrayiterator";
      }
      return type.slice(8, -1).toLowerCase().replace(/\s/g, "");
    };
    function ctorName(val) {
      return typeof val.constructor === "function" ? val.constructor.name : null;
    }
    function isArray(val) {
      if (Array.isArray) return Array.isArray(val);
      return val instanceof Array;
    }
    function isError(val) {
      return val instanceof Error || typeof val.message === "string" && val.constructor && typeof val.constructor.stackTraceLimit === "number";
    }
    function isDate(val) {
      if (val instanceof Date) return true;
      return typeof val.toDateString === "function" && typeof val.getDate === "function" && typeof val.setDate === "function";
    }
    function isRegexp(val) {
      if (val instanceof RegExp) return true;
      return typeof val.flags === "string" && typeof val.ignoreCase === "boolean" && typeof val.multiline === "boolean" && typeof val.global === "boolean";
    }
    function isGeneratorFn(name, val) {
      return ctorName(name) === "GeneratorFunction";
    }
    function isGeneratorObj(val) {
      return typeof val.throw === "function" && typeof val.return === "function" && typeof val.next === "function";
    }
    function isArguments(val) {
      try {
        if (typeof val.length === "number" && typeof val.callee === "function") {
          return true;
        }
      } catch (err) {
        if (err.message.indexOf("callee") !== -1) {
          return true;
        }
      }
      return false;
    }
    function isBuffer(val) {
      if (val.constructor && typeof val.constructor.isBuffer === "function") {
        return val.constructor.isBuffer(val);
      }
      return false;
    }
  }
});

// node_modules/.pnpm/is-extendable@0.1.1/node_modules/is-extendable/index.js
var require_is_extendable = __commonJS({
  "node_modules/.pnpm/is-extendable@0.1.1/node_modules/is-extendable/index.js"(exports2, module2) {
    "use strict";
    module2.exports = function isExtendable(val) {
      return typeof val !== "undefined" && val !== null && (typeof val === "object" || typeof val === "function");
    };
  }
});

// node_modules/.pnpm/extend-shallow@2.0.1/node_modules/extend-shallow/index.js
var require_extend_shallow = __commonJS({
  "node_modules/.pnpm/extend-shallow@2.0.1/node_modules/extend-shallow/index.js"(exports2, module2) {
    "use strict";
    var isObject = require_is_extendable();
    module2.exports = function extend(o) {
      if (!isObject(o)) {
        o = {};
      }
      var len = arguments.length;
      for (var i = 1; i < len; i++) {
        var obj = arguments[i];
        if (isObject(obj)) {
          assign(o, obj);
        }
      }
      return o;
    };
    function assign(a, b) {
      for (var key in b) {
        if (hasOwn(b, key)) {
          a[key] = b[key];
        }
      }
    }
    function hasOwn(obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key);
    }
  }
});

// node_modules/.pnpm/section-matter@1.0.0/node_modules/section-matter/index.js
var require_section_matter = __commonJS({
  "node_modules/.pnpm/section-matter@1.0.0/node_modules/section-matter/index.js"(exports2, module2) {
    "use strict";
    var typeOf = require_kind_of();
    var extend = require_extend_shallow();
    module2.exports = function(input, options2) {
      if (typeof options2 === "function") {
        options2 = { parse: options2 };
      }
      var file = toObject(input);
      var defaults = { section_delimiter: "---", parse: identity };
      var opts = extend({}, defaults, options2);
      var delim = opts.section_delimiter;
      var lines = file.content.split(/\r?\n/);
      var sections = null;
      var section = createSection();
      var content = [];
      var stack = [];
      function initSections(val) {
        file.content = val;
        sections = [];
        content = [];
      }
      function closeSection(val) {
        if (stack.length) {
          section.key = getKey(stack[0], delim);
          section.content = val;
          opts.parse(section, sections);
          sections.push(section);
          section = createSection();
          content = [];
          stack = [];
        }
      }
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var len = stack.length;
        var ln = line.trim();
        if (isDelimiter(ln, delim)) {
          if (ln.length === 3 && i !== 0) {
            if (len === 0 || len === 2) {
              content.push(line);
              continue;
            }
            stack.push(ln);
            section.data = content.join("\n");
            content = [];
            continue;
          }
          if (sections === null) {
            initSections(content.join("\n"));
          }
          if (len === 2) {
            closeSection(content.join("\n"));
          }
          stack.push(ln);
          continue;
        }
        content.push(line);
      }
      if (sections === null) {
        initSections(content.join("\n"));
      } else {
        closeSection(content.join("\n"));
      }
      file.sections = sections;
      return file;
    };
    function isDelimiter(line, delim) {
      if (line.slice(0, delim.length) !== delim) {
        return false;
      }
      if (line.charAt(delim.length + 1) === delim.slice(-1)) {
        return false;
      }
      return true;
    }
    function toObject(input) {
      if (typeOf(input) !== "object") {
        input = { content: input };
      }
      if (typeof input.content !== "string" && !isBuffer(input.content)) {
        throw new TypeError("expected a buffer or string");
      }
      input.content = input.content.toString();
      input.sections = [];
      return input;
    }
    function getKey(val, delim) {
      return val ? val.slice(delim.length).trim() : "";
    }
    function createSection() {
      return { key: "", data: "", content: "" };
    }
    function identity(val) {
      return val;
    }
    function isBuffer(val) {
      if (val && val.constructor && typeof val.constructor.isBuffer === "function") {
        return val.constructor.isBuffer(val);
      }
      return false;
    }
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/common.js
var require_common = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/common.js"(exports2, module2) {
    "use strict";
    function isNothing(subject) {
      return typeof subject === "undefined" || subject === null;
    }
    function isObject(subject) {
      return typeof subject === "object" && subject !== null;
    }
    function toArray(sequence) {
      if (Array.isArray(sequence)) return sequence;
      else if (isNothing(sequence)) return [];
      return [sequence];
    }
    function extend(target, source) {
      var index, length, key, sourceKeys;
      if (source) {
        sourceKeys = Object.keys(source);
        for (index = 0, length = sourceKeys.length; index < length; index += 1) {
          key = sourceKeys[index];
          target[key] = source[key];
        }
      }
      return target;
    }
    function repeat(string, count) {
      var result = "", cycle;
      for (cycle = 0; cycle < count; cycle += 1) {
        result += string;
      }
      return result;
    }
    function isNegativeZero(number) {
      return number === 0 && Number.NEGATIVE_INFINITY === 1 / number;
    }
    module2.exports.isNothing = isNothing;
    module2.exports.isObject = isObject;
    module2.exports.toArray = toArray;
    module2.exports.repeat = repeat;
    module2.exports.isNegativeZero = isNegativeZero;
    module2.exports.extend = extend;
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/exception.js
var require_exception = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/exception.js"(exports2, module2) {
    "use strict";
    function YAMLException(reason, mark) {
      Error.call(this);
      this.name = "YAMLException";
      this.reason = reason;
      this.mark = mark;
      this.message = (this.reason || "(unknown reason)") + (this.mark ? " " + this.mark.toString() : "");
      if (Error.captureStackTrace) {
        Error.captureStackTrace(this, this.constructor);
      } else {
        this.stack = new Error().stack || "";
      }
    }
    YAMLException.prototype = Object.create(Error.prototype);
    YAMLException.prototype.constructor = YAMLException;
    YAMLException.prototype.toString = function toString(compact) {
      var result = this.name + ": ";
      result += this.reason || "(unknown reason)";
      if (!compact && this.mark) {
        result += " " + this.mark.toString();
      }
      return result;
    };
    module2.exports = YAMLException;
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/mark.js
var require_mark = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/mark.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    function Mark(name, buffer, position, line, column) {
      this.name = name;
      this.buffer = buffer;
      this.position = position;
      this.line = line;
      this.column = column;
    }
    Mark.prototype.getSnippet = function getSnippet(indent, maxLength) {
      var head, start, tail, end, snippet;
      if (!this.buffer) return null;
      indent = indent || 4;
      maxLength = maxLength || 75;
      head = "";
      start = this.position;
      while (start > 0 && "\0\r\n\x85\u2028\u2029".indexOf(this.buffer.charAt(start - 1)) === -1) {
        start -= 1;
        if (this.position - start > maxLength / 2 - 1) {
          head = " ... ";
          start += 5;
          break;
        }
      }
      tail = "";
      end = this.position;
      while (end < this.buffer.length && "\0\r\n\x85\u2028\u2029".indexOf(this.buffer.charAt(end)) === -1) {
        end += 1;
        if (end - this.position > maxLength / 2 - 1) {
          tail = " ... ";
          end -= 5;
          break;
        }
      }
      snippet = this.buffer.slice(start, end);
      return common.repeat(" ", indent) + head + snippet + tail + "\n" + common.repeat(" ", indent + this.position - start + head.length) + "^";
    };
    Mark.prototype.toString = function toString(compact) {
      var snippet, where = "";
      if (this.name) {
        where += 'in "' + this.name + '" ';
      }
      where += "at line " + (this.line + 1) + ", column " + (this.column + 1);
      if (!compact) {
        snippet = this.getSnippet();
        if (snippet) {
          where += ":\n" + snippet;
        }
      }
      return where;
    };
    module2.exports = Mark;
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type.js
var require_type = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type.js"(exports2, module2) {
    "use strict";
    var YAMLException = require_exception();
    var TYPE_CONSTRUCTOR_OPTIONS = [
      "kind",
      "resolve",
      "construct",
      "instanceOf",
      "predicate",
      "represent",
      "defaultStyle",
      "styleAliases"
    ];
    var YAML_NODE_KINDS = [
      "scalar",
      "sequence",
      "mapping"
    ];
    function compileStyleAliases(map) {
      var result = {};
      if (map !== null) {
        Object.keys(map).forEach(function(style) {
          map[style].forEach(function(alias) {
            result[String(alias)] = style;
          });
        });
      }
      return result;
    }
    function Type(tag, options2) {
      options2 = options2 || {};
      Object.keys(options2).forEach(function(name) {
        if (TYPE_CONSTRUCTOR_OPTIONS.indexOf(name) === -1) {
          throw new YAMLException('Unknown option "' + name + '" is met in definition of "' + tag + '" YAML type.');
        }
      });
      this.tag = tag;
      this.kind = options2["kind"] || null;
      this.resolve = options2["resolve"] || function() {
        return true;
      };
      this.construct = options2["construct"] || function(data) {
        return data;
      };
      this.instanceOf = options2["instanceOf"] || null;
      this.predicate = options2["predicate"] || null;
      this.represent = options2["represent"] || null;
      this.defaultStyle = options2["defaultStyle"] || null;
      this.styleAliases = compileStyleAliases(options2["styleAliases"] || null);
      if (YAML_NODE_KINDS.indexOf(this.kind) === -1) {
        throw new YAMLException('Unknown kind "' + this.kind + '" is specified for "' + tag + '" YAML type.');
      }
    }
    module2.exports = Type;
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema.js
var require_schema = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    var YAMLException = require_exception();
    var Type = require_type();
    function compileList(schema, name, result) {
      var exclude = [];
      schema.include.forEach(function(includedSchema) {
        result = compileList(includedSchema, name, result);
      });
      schema[name].forEach(function(currentType) {
        result.forEach(function(previousType, previousIndex) {
          if (previousType.tag === currentType.tag && previousType.kind === currentType.kind) {
            exclude.push(previousIndex);
          }
        });
        result.push(currentType);
      });
      return result.filter(function(type, index) {
        return exclude.indexOf(index) === -1;
      });
    }
    function compileMap() {
      var result = {
        scalar: {},
        sequence: {},
        mapping: {},
        fallback: {}
      }, index, length;
      function collectType(type) {
        result[type.kind][type.tag] = result["fallback"][type.tag] = type;
      }
      for (index = 0, length = arguments.length; index < length; index += 1) {
        arguments[index].forEach(collectType);
      }
      return result;
    }
    function Schema(definition) {
      this.include = definition.include || [];
      this.implicit = definition.implicit || [];
      this.explicit = definition.explicit || [];
      this.implicit.forEach(function(type) {
        if (type.loadKind && type.loadKind !== "scalar") {
          throw new YAMLException("There is a non-scalar type in the implicit list of a schema. Implicit resolving of such types is not supported.");
        }
      });
      this.compiledImplicit = compileList(this, "implicit", []);
      this.compiledExplicit = compileList(this, "explicit", []);
      this.compiledTypeMap = compileMap(this.compiledImplicit, this.compiledExplicit);
    }
    Schema.DEFAULT = null;
    Schema.create = function createSchema() {
      var schemas, types;
      switch (arguments.length) {
        case 1:
          schemas = Schema.DEFAULT;
          types = arguments[0];
          break;
        case 2:
          schemas = arguments[0];
          types = arguments[1];
          break;
        default:
          throw new YAMLException("Wrong number of arguments for Schema.create function");
      }
      schemas = common.toArray(schemas);
      types = common.toArray(types);
      if (!schemas.every(function(schema) {
        return schema instanceof Schema;
      })) {
        throw new YAMLException("Specified list of super schemas (or a single Schema object) contains a non-Schema object.");
      }
      if (!types.every(function(type) {
        return type instanceof Type;
      })) {
        throw new YAMLException("Specified list of YAML types (or a single Type object) contains a non-Type object.");
      }
      return new Schema({
        include: schemas,
        explicit: types
      });
    };
    module2.exports = Schema;
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/str.js
var require_str = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/str.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    module2.exports = new Type("tag:yaml.org,2002:str", {
      kind: "scalar",
      construct: function(data) {
        return data !== null ? data : "";
      }
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/seq.js
var require_seq = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/seq.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    module2.exports = new Type("tag:yaml.org,2002:seq", {
      kind: "sequence",
      construct: function(data) {
        return data !== null ? data : [];
      }
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/map.js
var require_map = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/map.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    module2.exports = new Type("tag:yaml.org,2002:map", {
      kind: "mapping",
      construct: function(data) {
        return data !== null ? data : {};
      }
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema/failsafe.js
var require_failsafe = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema/failsafe.js"(exports2, module2) {
    "use strict";
    var Schema = require_schema();
    module2.exports = new Schema({
      explicit: [
        require_str(),
        require_seq(),
        require_map()
      ]
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/null.js
var require_null = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/null.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    function resolveYamlNull(data) {
      if (data === null) return true;
      var max = data.length;
      return max === 1 && data === "~" || max === 4 && (data === "null" || data === "Null" || data === "NULL");
    }
    function constructYamlNull() {
      return null;
    }
    function isNull(object) {
      return object === null;
    }
    module2.exports = new Type("tag:yaml.org,2002:null", {
      kind: "scalar",
      resolve: resolveYamlNull,
      construct: constructYamlNull,
      predicate: isNull,
      represent: {
        canonical: function() {
          return "~";
        },
        lowercase: function() {
          return "null";
        },
        uppercase: function() {
          return "NULL";
        },
        camelcase: function() {
          return "Null";
        }
      },
      defaultStyle: "lowercase"
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/bool.js
var require_bool = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/bool.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    function resolveYamlBoolean(data) {
      if (data === null) return false;
      var max = data.length;
      return max === 4 && (data === "true" || data === "True" || data === "TRUE") || max === 5 && (data === "false" || data === "False" || data === "FALSE");
    }
    function constructYamlBoolean(data) {
      return data === "true" || data === "True" || data === "TRUE";
    }
    function isBoolean(object) {
      return Object.prototype.toString.call(object) === "[object Boolean]";
    }
    module2.exports = new Type("tag:yaml.org,2002:bool", {
      kind: "scalar",
      resolve: resolveYamlBoolean,
      construct: constructYamlBoolean,
      predicate: isBoolean,
      represent: {
        lowercase: function(object) {
          return object ? "true" : "false";
        },
        uppercase: function(object) {
          return object ? "TRUE" : "FALSE";
        },
        camelcase: function(object) {
          return object ? "True" : "False";
        }
      },
      defaultStyle: "lowercase"
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/int.js
var require_int = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/int.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    var Type = require_type();
    function isHexCode(c) {
      return 48 <= c && c <= 57 || 65 <= c && c <= 70 || 97 <= c && c <= 102;
    }
    function isOctCode(c) {
      return 48 <= c && c <= 55;
    }
    function isDecCode(c) {
      return 48 <= c && c <= 57;
    }
    function resolveYamlInteger(data) {
      if (data === null) return false;
      var max = data.length, index = 0, hasDigits = false, ch;
      if (!max) return false;
      ch = data[index];
      if (ch === "-" || ch === "+") {
        ch = data[++index];
      }
      if (ch === "0") {
        if (index + 1 === max) return true;
        ch = data[++index];
        if (ch === "b") {
          index++;
          for (; index < max; index++) {
            ch = data[index];
            if (ch === "_") continue;
            if (ch !== "0" && ch !== "1") return false;
            hasDigits = true;
          }
          return hasDigits && ch !== "_";
        }
        if (ch === "x") {
          index++;
          for (; index < max; index++) {
            ch = data[index];
            if (ch === "_") continue;
            if (!isHexCode(data.charCodeAt(index))) return false;
            hasDigits = true;
          }
          return hasDigits && ch !== "_";
        }
        for (; index < max; index++) {
          ch = data[index];
          if (ch === "_") continue;
          if (!isOctCode(data.charCodeAt(index))) return false;
          hasDigits = true;
        }
        return hasDigits && ch !== "_";
      }
      if (ch === "_") return false;
      for (; index < max; index++) {
        ch = data[index];
        if (ch === "_") continue;
        if (ch === ":") break;
        if (!isDecCode(data.charCodeAt(index))) {
          return false;
        }
        hasDigits = true;
      }
      if (!hasDigits || ch === "_") return false;
      if (ch !== ":") return true;
      return /^(:[0-5]?[0-9])+$/.test(data.slice(index));
    }
    function constructYamlInteger(data) {
      var value = data, sign = 1, ch, base, digits = [];
      if (value.indexOf("_") !== -1) {
        value = value.replace(/_/g, "");
      }
      ch = value[0];
      if (ch === "-" || ch === "+") {
        if (ch === "-") sign = -1;
        value = value.slice(1);
        ch = value[0];
      }
      if (value === "0") return 0;
      if (ch === "0") {
        if (value[1] === "b") return sign * parseInt(value.slice(2), 2);
        if (value[1] === "x") return sign * parseInt(value, 16);
        return sign * parseInt(value, 8);
      }
      if (value.indexOf(":") !== -1) {
        value.split(":").forEach(function(v) {
          digits.unshift(parseInt(v, 10));
        });
        value = 0;
        base = 1;
        digits.forEach(function(d) {
          value += d * base;
          base *= 60;
        });
        return sign * value;
      }
      return sign * parseInt(value, 10);
    }
    function isInteger(object) {
      return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 === 0 && !common.isNegativeZero(object));
    }
    module2.exports = new Type("tag:yaml.org,2002:int", {
      kind: "scalar",
      resolve: resolveYamlInteger,
      construct: constructYamlInteger,
      predicate: isInteger,
      represent: {
        binary: function(obj) {
          return obj >= 0 ? "0b" + obj.toString(2) : "-0b" + obj.toString(2).slice(1);
        },
        octal: function(obj) {
          return obj >= 0 ? "0" + obj.toString(8) : "-0" + obj.toString(8).slice(1);
        },
        decimal: function(obj) {
          return obj.toString(10);
        },
        /* eslint-disable max-len */
        hexadecimal: function(obj) {
          return obj >= 0 ? "0x" + obj.toString(16).toUpperCase() : "-0x" + obj.toString(16).toUpperCase().slice(1);
        }
      },
      defaultStyle: "decimal",
      styleAliases: {
        binary: [2, "bin"],
        octal: [8, "oct"],
        decimal: [10, "dec"],
        hexadecimal: [16, "hex"]
      }
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/float.js
var require_float = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/float.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    var Type = require_type();
    var YAML_FLOAT_PATTERN = new RegExp(
      // 2.5e4, 2.5 and integers
      "^(?:[-+]?(?:0|[1-9][0-9_]*)(?:\\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\\.[0-9_]*|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$"
    );
    function resolveYamlFloat(data) {
      if (data === null) return false;
      if (!YAML_FLOAT_PATTERN.test(data) || // Quick hack to not allow integers end with `_`
      // Probably should update regexp & check speed
      data[data.length - 1] === "_") {
        return false;
      }
      return true;
    }
    function constructYamlFloat(data) {
      var value, sign, base, digits;
      value = data.replace(/_/g, "").toLowerCase();
      sign = value[0] === "-" ? -1 : 1;
      digits = [];
      if ("+-".indexOf(value[0]) >= 0) {
        value = value.slice(1);
      }
      if (value === ".inf") {
        return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      } else if (value === ".nan") {
        return NaN;
      } else if (value.indexOf(":") >= 0) {
        value.split(":").forEach(function(v) {
          digits.unshift(parseFloat(v, 10));
        });
        value = 0;
        base = 1;
        digits.forEach(function(d) {
          value += d * base;
          base *= 60;
        });
        return sign * value;
      }
      return sign * parseFloat(value, 10);
    }
    var SCIENTIFIC_WITHOUT_DOT = /^[-+]?[0-9]+e/;
    function representYamlFloat(object, style) {
      var res;
      if (isNaN(object)) {
        switch (style) {
          case "lowercase":
            return ".nan";
          case "uppercase":
            return ".NAN";
          case "camelcase":
            return ".NaN";
        }
      } else if (Number.POSITIVE_INFINITY === object) {
        switch (style) {
          case "lowercase":
            return ".inf";
          case "uppercase":
            return ".INF";
          case "camelcase":
            return ".Inf";
        }
      } else if (Number.NEGATIVE_INFINITY === object) {
        switch (style) {
          case "lowercase":
            return "-.inf";
          case "uppercase":
            return "-.INF";
          case "camelcase":
            return "-.Inf";
        }
      } else if (common.isNegativeZero(object)) {
        return "-0.0";
      }
      res = object.toString(10);
      return SCIENTIFIC_WITHOUT_DOT.test(res) ? res.replace("e", ".e") : res;
    }
    function isFloat(object) {
      return Object.prototype.toString.call(object) === "[object Number]" && (object % 1 !== 0 || common.isNegativeZero(object));
    }
    module2.exports = new Type("tag:yaml.org,2002:float", {
      kind: "scalar",
      resolve: resolveYamlFloat,
      construct: constructYamlFloat,
      predicate: isFloat,
      represent: representYamlFloat,
      defaultStyle: "lowercase"
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema/json.js
var require_json = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema/json.js"(exports2, module2) {
    "use strict";
    var Schema = require_schema();
    module2.exports = new Schema({
      include: [
        require_failsafe()
      ],
      implicit: [
        require_null(),
        require_bool(),
        require_int(),
        require_float()
      ]
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema/core.js
var require_core = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema/core.js"(exports2, module2) {
    "use strict";
    var Schema = require_schema();
    module2.exports = new Schema({
      include: [
        require_json()
      ]
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/timestamp.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    var YAML_DATE_REGEXP = new RegExp(
      "^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$"
    );
    var YAML_TIMESTAMP_REGEXP = new RegExp(
      "^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$"
    );
    function resolveYamlTimestamp(data) {
      if (data === null) return false;
      if (YAML_DATE_REGEXP.exec(data) !== null) return true;
      if (YAML_TIMESTAMP_REGEXP.exec(data) !== null) return true;
      return false;
    }
    function constructYamlTimestamp(data) {
      var match, year, month, day, hour, minute, second, fraction = 0, delta = null, tz_hour, tz_minute, date;
      match = YAML_DATE_REGEXP.exec(data);
      if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(data);
      if (match === null) throw new Error("Date resolve error");
      year = +match[1];
      month = +match[2] - 1;
      day = +match[3];
      if (!match[4]) {
        return new Date(Date.UTC(year, month, day));
      }
      hour = +match[4];
      minute = +match[5];
      second = +match[6];
      if (match[7]) {
        fraction = match[7].slice(0, 3);
        while (fraction.length < 3) {
          fraction += "0";
        }
        fraction = +fraction;
      }
      if (match[9]) {
        tz_hour = +match[10];
        tz_minute = +(match[11] || 0);
        delta = (tz_hour * 60 + tz_minute) * 6e4;
        if (match[9] === "-") delta = -delta;
      }
      date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
      if (delta) date.setTime(date.getTime() - delta);
      return date;
    }
    function representYamlTimestamp(object) {
      return object.toISOString();
    }
    module2.exports = new Type("tag:yaml.org,2002:timestamp", {
      kind: "scalar",
      resolve: resolveYamlTimestamp,
      construct: constructYamlTimestamp,
      instanceOf: Date,
      represent: representYamlTimestamp
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/merge.js
var require_merge = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/merge.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    function resolveYamlMerge(data) {
      return data === "<<" || data === null;
    }
    module2.exports = new Type("tag:yaml.org,2002:merge", {
      kind: "scalar",
      resolve: resolveYamlMerge
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/binary.js
var require_binary = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/binary.js"(exports2, module2) {
    "use strict";
    var NodeBuffer;
    try {
      _require = require;
      NodeBuffer = _require("buffer").Buffer;
    } catch (__) {
    }
    var _require;
    var Type = require_type();
    var BASE64_MAP = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r";
    function resolveYamlBinary(data) {
      if (data === null) return false;
      var code, idx, bitlen = 0, max = data.length, map = BASE64_MAP;
      for (idx = 0; idx < max; idx++) {
        code = map.indexOf(data.charAt(idx));
        if (code > 64) continue;
        if (code < 0) return false;
        bitlen += 6;
      }
      return bitlen % 8 === 0;
    }
    function constructYamlBinary(data) {
      var idx, tailbits, input = data.replace(/[\r\n=]/g, ""), max = input.length, map = BASE64_MAP, bits = 0, result = [];
      for (idx = 0; idx < max; idx++) {
        if (idx % 4 === 0 && idx) {
          result.push(bits >> 16 & 255);
          result.push(bits >> 8 & 255);
          result.push(bits & 255);
        }
        bits = bits << 6 | map.indexOf(input.charAt(idx));
      }
      tailbits = max % 4 * 6;
      if (tailbits === 0) {
        result.push(bits >> 16 & 255);
        result.push(bits >> 8 & 255);
        result.push(bits & 255);
      } else if (tailbits === 18) {
        result.push(bits >> 10 & 255);
        result.push(bits >> 2 & 255);
      } else if (tailbits === 12) {
        result.push(bits >> 4 & 255);
      }
      if (NodeBuffer) {
        return NodeBuffer.from ? NodeBuffer.from(result) : new NodeBuffer(result);
      }
      return result;
    }
    function representYamlBinary(object) {
      var result = "", bits = 0, idx, tail, max = object.length, map = BASE64_MAP;
      for (idx = 0; idx < max; idx++) {
        if (idx % 3 === 0 && idx) {
          result += map[bits >> 18 & 63];
          result += map[bits >> 12 & 63];
          result += map[bits >> 6 & 63];
          result += map[bits & 63];
        }
        bits = (bits << 8) + object[idx];
      }
      tail = max % 3;
      if (tail === 0) {
        result += map[bits >> 18 & 63];
        result += map[bits >> 12 & 63];
        result += map[bits >> 6 & 63];
        result += map[bits & 63];
      } else if (tail === 2) {
        result += map[bits >> 10 & 63];
        result += map[bits >> 4 & 63];
        result += map[bits << 2 & 63];
        result += map[64];
      } else if (tail === 1) {
        result += map[bits >> 2 & 63];
        result += map[bits << 4 & 63];
        result += map[64];
        result += map[64];
      }
      return result;
    }
    function isBinary(object) {
      return NodeBuffer && NodeBuffer.isBuffer(object);
    }
    module2.exports = new Type("tag:yaml.org,2002:binary", {
      kind: "scalar",
      resolve: resolveYamlBinary,
      construct: constructYamlBinary,
      predicate: isBinary,
      represent: representYamlBinary
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/omap.js
var require_omap = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/omap.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    var _hasOwnProperty = Object.prototype.hasOwnProperty;
    var _toString = Object.prototype.toString;
    function resolveYamlOmap(data) {
      if (data === null) return true;
      var objectKeys = {}, index, length, pair, pairKey, pairHasKey, object = data;
      for (index = 0, length = object.length; index < length; index += 1) {
        pair = object[index];
        pairHasKey = false;
        if (_toString.call(pair) !== "[object Object]") return false;
        for (pairKey in pair) {
          if (_hasOwnProperty.call(pair, pairKey)) {
            if (!pairHasKey) pairHasKey = true;
            else return false;
          }
        }
        if (!pairHasKey) return false;
        if (_hasOwnProperty.call(objectKeys, pairKey)) return false;
        Object.defineProperty(objectKeys, pairKey, { value: true });
      }
      return true;
    }
    function constructYamlOmap(data) {
      return data !== null ? data : [];
    }
    module2.exports = new Type("tag:yaml.org,2002:omap", {
      kind: "sequence",
      resolve: resolveYamlOmap,
      construct: constructYamlOmap
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/pairs.js
var require_pairs = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/pairs.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    var _toString = Object.prototype.toString;
    function resolveYamlPairs(data) {
      if (data === null) return true;
      var index, length, pair, keys, result, object = data;
      result = new Array(object.length);
      for (index = 0, length = object.length; index < length; index += 1) {
        pair = object[index];
        if (_toString.call(pair) !== "[object Object]") return false;
        keys = Object.keys(pair);
        if (keys.length !== 1) return false;
        result[index] = [keys[0], pair[keys[0]]];
      }
      return true;
    }
    function constructYamlPairs(data) {
      if (data === null) return [];
      var index, length, pair, keys, result, object = data;
      result = new Array(object.length);
      for (index = 0, length = object.length; index < length; index += 1) {
        pair = object[index];
        keys = Object.keys(pair);
        result[index] = [keys[0], pair[keys[0]]];
      }
      return result;
    }
    module2.exports = new Type("tag:yaml.org,2002:pairs", {
      kind: "sequence",
      resolve: resolveYamlPairs,
      construct: constructYamlPairs
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/set.js
var require_set = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/set.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    var _hasOwnProperty = Object.prototype.hasOwnProperty;
    function resolveYamlSet(data) {
      if (data === null) return true;
      var key, object = data;
      for (key in object) {
        if (_hasOwnProperty.call(object, key)) {
          if (object[key] !== null) return false;
        }
      }
      return true;
    }
    function constructYamlSet(data) {
      return data !== null ? data : {};
    }
    module2.exports = new Type("tag:yaml.org,2002:set", {
      kind: "mapping",
      resolve: resolveYamlSet,
      construct: constructYamlSet
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema/default_safe.js
var require_default_safe = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema/default_safe.js"(exports2, module2) {
    "use strict";
    var Schema = require_schema();
    module2.exports = new Schema({
      include: [
        require_core()
      ],
      implicit: [
        require_timestamp(),
        require_merge()
      ],
      explicit: [
        require_binary(),
        require_omap(),
        require_pairs(),
        require_set()
      ]
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/js/undefined.js
var require_undefined = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/js/undefined.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    function resolveJavascriptUndefined() {
      return true;
    }
    function constructJavascriptUndefined() {
      return void 0;
    }
    function representJavascriptUndefined() {
      return "";
    }
    function isUndefined(object) {
      return typeof object === "undefined";
    }
    module2.exports = new Type("tag:yaml.org,2002:js/undefined", {
      kind: "scalar",
      resolve: resolveJavascriptUndefined,
      construct: constructJavascriptUndefined,
      predicate: isUndefined,
      represent: representJavascriptUndefined
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/js/regexp.js
var require_regexp = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/js/regexp.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    function resolveJavascriptRegExp(data) {
      if (data === null) return false;
      if (data.length === 0) return false;
      var regexp = data, tail = /\/([gim]*)$/.exec(data), modifiers = "";
      if (regexp[0] === "/") {
        if (tail) modifiers = tail[1];
        if (modifiers.length > 3) return false;
        if (regexp[regexp.length - modifiers.length - 1] !== "/") return false;
      }
      return true;
    }
    function constructJavascriptRegExp(data) {
      var regexp = data, tail = /\/([gim]*)$/.exec(data), modifiers = "";
      if (regexp[0] === "/") {
        if (tail) modifiers = tail[1];
        regexp = regexp.slice(1, regexp.length - modifiers.length - 1);
      }
      return new RegExp(regexp, modifiers);
    }
    function representJavascriptRegExp(object) {
      var result = "/" + object.source + "/";
      if (object.global) result += "g";
      if (object.multiline) result += "m";
      if (object.ignoreCase) result += "i";
      return result;
    }
    function isRegExp(object) {
      return Object.prototype.toString.call(object) === "[object RegExp]";
    }
    module2.exports = new Type("tag:yaml.org,2002:js/regexp", {
      kind: "scalar",
      resolve: resolveJavascriptRegExp,
      construct: constructJavascriptRegExp,
      predicate: isRegExp,
      represent: representJavascriptRegExp
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/js/function.js
var require_function = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/type/js/function.js"(exports2, module2) {
    "use strict";
    var esprima;
    try {
      _require = require;
      esprima = _require("esprima");
    } catch (_) {
      if (typeof window !== "undefined") esprima = window.esprima;
    }
    var _require;
    var Type = require_type();
    function resolveJavascriptFunction(data) {
      if (data === null) return false;
      try {
        var source = "(" + data + ")", ast = esprima.parse(source, { range: true });
        if (ast.type !== "Program" || ast.body.length !== 1 || ast.body[0].type !== "ExpressionStatement" || ast.body[0].expression.type !== "ArrowFunctionExpression" && ast.body[0].expression.type !== "FunctionExpression") {
          return false;
        }
        return true;
      } catch (err) {
        return false;
      }
    }
    function constructJavascriptFunction(data) {
      var source = "(" + data + ")", ast = esprima.parse(source, { range: true }), params = [], body;
      if (ast.type !== "Program" || ast.body.length !== 1 || ast.body[0].type !== "ExpressionStatement" || ast.body[0].expression.type !== "ArrowFunctionExpression" && ast.body[0].expression.type !== "FunctionExpression") {
        throw new Error("Failed to resolve function");
      }
      ast.body[0].expression.params.forEach(function(param) {
        params.push(param.name);
      });
      body = ast.body[0].expression.body.range;
      if (ast.body[0].expression.body.type === "BlockStatement") {
        return new Function(params, source.slice(body[0] + 1, body[1] - 1));
      }
      return new Function(params, "return " + source.slice(body[0], body[1]));
    }
    function representJavascriptFunction(object) {
      return object.toString();
    }
    function isFunction(object) {
      return Object.prototype.toString.call(object) === "[object Function]";
    }
    module2.exports = new Type("tag:yaml.org,2002:js/function", {
      kind: "scalar",
      resolve: resolveJavascriptFunction,
      construct: constructJavascriptFunction,
      predicate: isFunction,
      represent: representJavascriptFunction
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema/default_full.js
var require_default_full = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/schema/default_full.js"(exports2, module2) {
    "use strict";
    var Schema = require_schema();
    module2.exports = Schema.DEFAULT = new Schema({
      include: [
        require_default_safe()
      ],
      explicit: [
        require_undefined(),
        require_regexp(),
        require_function()
      ]
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/loader.js
var require_loader = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/loader.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    var YAMLException = require_exception();
    var Mark = require_mark();
    var DEFAULT_SAFE_SCHEMA = require_default_safe();
    var DEFAULT_FULL_SCHEMA = require_default_full();
    var _hasOwnProperty = Object.prototype.hasOwnProperty;
    var CONTEXT_FLOW_IN = 1;
    var CONTEXT_FLOW_OUT = 2;
    var CONTEXT_BLOCK_IN = 3;
    var CONTEXT_BLOCK_OUT = 4;
    var CHOMPING_CLIP = 1;
    var CHOMPING_STRIP = 2;
    var CHOMPING_KEEP = 3;
    var PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
    var PATTERN_NON_ASCII_LINE_BREAKS = /[\x85\u2028\u2029]/;
    var PATTERN_FLOW_INDICATORS = /[,\[\]\{\}]/;
    var PATTERN_TAG_HANDLE = /^(?:!|!!|![a-z\-]+!)$/i;
    var PATTERN_TAG_URI = /^(?:!|[^,\[\]\{\}])(?:%[0-9a-f]{2}|[0-9a-z\-#;\/\?:@&=\+\$,_\.!~\*'\(\)\[\]])*$/i;
    function _class(obj) {
      return Object.prototype.toString.call(obj);
    }
    function is_EOL(c) {
      return c === 10 || c === 13;
    }
    function is_WHITE_SPACE(c) {
      return c === 9 || c === 32;
    }
    function is_WS_OR_EOL(c) {
      return c === 9 || c === 32 || c === 10 || c === 13;
    }
    function is_FLOW_INDICATOR(c) {
      return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
    }
    function fromHexCode(c) {
      var lc;
      if (48 <= c && c <= 57) {
        return c - 48;
      }
      lc = c | 32;
      if (97 <= lc && lc <= 102) {
        return lc - 97 + 10;
      }
      return -1;
    }
    function escapedHexLen(c) {
      if (c === 120) {
        return 2;
      }
      if (c === 117) {
        return 4;
      }
      if (c === 85) {
        return 8;
      }
      return 0;
    }
    function fromDecimalCode(c) {
      if (48 <= c && c <= 57) {
        return c - 48;
      }
      return -1;
    }
    function simpleEscapeSequence(c) {
      return c === 48 ? "\0" : c === 97 ? "\x07" : c === 98 ? "\b" : c === 116 ? "	" : c === 9 ? "	" : c === 110 ? "\n" : c === 118 ? "\v" : c === 102 ? "\f" : c === 114 ? "\r" : c === 101 ? "\x1B" : c === 32 ? " " : c === 34 ? '"' : c === 47 ? "/" : c === 92 ? "\\" : c === 78 ? "\x85" : c === 95 ? "\xA0" : c === 76 ? "\u2028" : c === 80 ? "\u2029" : "";
    }
    function charFromCodepoint(c) {
      if (c <= 65535) {
        return String.fromCharCode(c);
      }
      return String.fromCharCode(
        (c - 65536 >> 10) + 55296,
        (c - 65536 & 1023) + 56320
      );
    }
    function setProperty(object, key, value) {
      if (key === "__proto__") {
        Object.defineProperty(object, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value
        });
      } else {
        object[key] = value;
      }
    }
    var simpleEscapeCheck = new Array(256);
    var simpleEscapeMap = new Array(256);
    for (i = 0; i < 256; i++) {
      simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
      simpleEscapeMap[i] = simpleEscapeSequence(i);
    }
    var i;
    function State(input, options2) {
      this.input = input;
      this.filename = options2["filename"] || null;
      this.schema = options2["schema"] || DEFAULT_FULL_SCHEMA;
      this.onWarning = options2["onWarning"] || null;
      this.legacy = options2["legacy"] || false;
      this.json = options2["json"] || false;
      this.listener = options2["listener"] || null;
      this.maxTotalMergeKeys = typeof options2["maxTotalMergeKeys"] === "number" ? options2["maxTotalMergeKeys"] : 1e4;
      this.implicitTypes = this.schema.compiledImplicit;
      this.typeMap = this.schema.compiledTypeMap;
      this.length = input.length;
      this.position = 0;
      this.line = 0;
      this.lineStart = 0;
      this.lineIndent = 0;
      this.totalMergeKeys = 0;
      this.documents = [];
    }
    function generateError(state, message) {
      return new YAMLException(
        message,
        new Mark(state.filename, state.input, state.position, state.line, state.position - state.lineStart)
      );
    }
    function throwError(state, message) {
      throw generateError(state, message);
    }
    function throwWarning(state, message) {
      if (state.onWarning) {
        state.onWarning.call(null, generateError(state, message));
      }
    }
    var directiveHandlers = {
      YAML: function handleYamlDirective(state, name, args) {
        var match, major, minor;
        if (state.version !== null) {
          throwError(state, "duplication of %YAML directive");
        }
        if (args.length !== 1) {
          throwError(state, "YAML directive accepts exactly one argument");
        }
        match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
        if (match === null) {
          throwError(state, "ill-formed argument of the YAML directive");
        }
        major = parseInt(match[1], 10);
        minor = parseInt(match[2], 10);
        if (major !== 1) {
          throwError(state, "unacceptable YAML version of the document");
        }
        state.version = args[0];
        state.checkLineBreaks = minor < 2;
        if (minor !== 1 && minor !== 2) {
          throwWarning(state, "unsupported YAML version of the document");
        }
      },
      TAG: function handleTagDirective(state, name, args) {
        var handle, prefix;
        if (args.length !== 2) {
          throwError(state, "TAG directive accepts exactly two arguments");
        }
        handle = args[0];
        prefix = args[1];
        if (!PATTERN_TAG_HANDLE.test(handle)) {
          throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
        }
        if (_hasOwnProperty.call(state.tagMap, handle)) {
          throwError(state, 'there is a previously declared suffix for "' + handle + '" tag handle');
        }
        if (!PATTERN_TAG_URI.test(prefix)) {
          throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
        }
        state.tagMap[handle] = prefix;
      }
    };
    function captureSegment(state, start, end, checkJson) {
      var _position, _length, _character, _result;
      if (start < end) {
        _result = state.input.slice(start, end);
        if (checkJson) {
          for (_position = 0, _length = _result.length; _position < _length; _position += 1) {
            _character = _result.charCodeAt(_position);
            if (!(_character === 9 || 32 <= _character && _character <= 1114111)) {
              throwError(state, "expected valid JSON character");
            }
          }
        } else if (PATTERN_NON_PRINTABLE.test(_result)) {
          throwError(state, "the stream contains non-printable characters");
        }
        state.result += _result;
      }
    }
    function mergeMappings(state, destination, source, overridableKeys) {
      var sourceKeys, key, index, quantity;
      if (!common.isObject(source)) {
        throwError(state, "cannot merge mappings; the provided source object is unacceptable");
      }
      sourceKeys = Object.keys(source);
      for (index = 0, quantity = sourceKeys.length; index < quantity; index += 1) {
        key = sourceKeys[index];
        if (state.maxTotalMergeKeys !== -1 && ++state.totalMergeKeys > state.maxTotalMergeKeys) {
          throwError(state, "merge keys exceeded maxTotalMergeKeys (" + state.maxTotalMergeKeys + ")");
        }
        if (!_hasOwnProperty.call(destination, key)) {
          setProperty(destination, key, source[key]);
          overridableKeys[key] = true;
        }
      }
    }
    function storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, startLine, startPos) {
      var index, quantity;
      if (Array.isArray(keyNode)) {
        keyNode = Array.prototype.slice.call(keyNode);
        for (index = 0, quantity = keyNode.length; index < quantity; index += 1) {
          if (Array.isArray(keyNode[index])) {
            throwError(state, "nested arrays are not supported inside keys");
          }
          if (typeof keyNode === "object" && _class(keyNode[index]) === "[object Object]") {
            keyNode[index] = "[object Object]";
          }
        }
      }
      if (typeof keyNode === "object" && _class(keyNode) === "[object Object]") {
        keyNode = "[object Object]";
      }
      keyNode = String(keyNode);
      if (_result === null) {
        _result = {};
      }
      if (keyTag === "tag:yaml.org,2002:merge") {
        if (Array.isArray(valueNode)) {
          for (index = 0, quantity = valueNode.length; index < quantity; index += 1) {
            mergeMappings(state, _result, valueNode[index], overridableKeys);
          }
        } else {
          mergeMappings(state, _result, valueNode, overridableKeys);
        }
      } else {
        if (!state.json && !_hasOwnProperty.call(overridableKeys, keyNode) && _hasOwnProperty.call(_result, keyNode)) {
          state.line = startLine || state.line;
          state.position = startPos || state.position;
          throwError(state, "duplicated mapping key");
        }
        setProperty(_result, keyNode, valueNode);
        delete overridableKeys[keyNode];
      }
      return _result;
    }
    function readLineBreak(state) {
      var ch;
      ch = state.input.charCodeAt(state.position);
      if (ch === 10) {
        state.position++;
      } else if (ch === 13) {
        state.position++;
        if (state.input.charCodeAt(state.position) === 10) {
          state.position++;
        }
      } else {
        throwError(state, "a line break is expected");
      }
      state.line += 1;
      state.lineStart = state.position;
    }
    function skipSeparationSpace(state, allowComments, checkIndent) {
      var lineBreaks = 0, ch = state.input.charCodeAt(state.position);
      while (ch !== 0) {
        while (is_WHITE_SPACE(ch)) {
          ch = state.input.charCodeAt(++state.position);
        }
        if (allowComments && ch === 35) {
          do {
            ch = state.input.charCodeAt(++state.position);
          } while (ch !== 10 && ch !== 13 && ch !== 0);
        }
        if (is_EOL(ch)) {
          readLineBreak(state);
          ch = state.input.charCodeAt(state.position);
          lineBreaks++;
          state.lineIndent = 0;
          while (ch === 32) {
            state.lineIndent++;
            ch = state.input.charCodeAt(++state.position);
          }
        } else {
          break;
        }
      }
      if (checkIndent !== -1 && lineBreaks !== 0 && state.lineIndent < checkIndent) {
        throwWarning(state, "deficient indentation");
      }
      return lineBreaks;
    }
    function testDocumentSeparator(state) {
      var _position = state.position, ch;
      ch = state.input.charCodeAt(_position);
      if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(_position + 1) && ch === state.input.charCodeAt(_position + 2)) {
        _position += 3;
        ch = state.input.charCodeAt(_position);
        if (ch === 0 || is_WS_OR_EOL(ch)) {
          return true;
        }
      }
      return false;
    }
    function writeFoldedLines(state, count) {
      if (count === 1) {
        state.result += " ";
      } else if (count > 1) {
        state.result += common.repeat("\n", count - 1);
      }
    }
    function readPlainScalar(state, nodeIndent, withinFlowCollection) {
      var preceding, following, captureStart, captureEnd, hasPendingContent, _line, _lineStart, _lineIndent, _kind = state.kind, _result = state.result, ch;
      ch = state.input.charCodeAt(state.position);
      if (is_WS_OR_EOL(ch) || is_FLOW_INDICATOR(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96) {
        return false;
      }
      if (ch === 63 || ch === 45) {
        following = state.input.charCodeAt(state.position + 1);
        if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
          return false;
        }
      }
      state.kind = "scalar";
      state.result = "";
      captureStart = captureEnd = state.position;
      hasPendingContent = false;
      while (ch !== 0) {
        if (ch === 58) {
          following = state.input.charCodeAt(state.position + 1);
          if (is_WS_OR_EOL(following) || withinFlowCollection && is_FLOW_INDICATOR(following)) {
            break;
          }
        } else if (ch === 35) {
          preceding = state.input.charCodeAt(state.position - 1);
          if (is_WS_OR_EOL(preceding)) {
            break;
          }
        } else if (state.position === state.lineStart && testDocumentSeparator(state) || withinFlowCollection && is_FLOW_INDICATOR(ch)) {
          break;
        } else if (is_EOL(ch)) {
          _line = state.line;
          _lineStart = state.lineStart;
          _lineIndent = state.lineIndent;
          skipSeparationSpace(state, false, -1);
          if (state.lineIndent >= nodeIndent) {
            hasPendingContent = true;
            ch = state.input.charCodeAt(state.position);
            continue;
          } else {
            state.position = captureEnd;
            state.line = _line;
            state.lineStart = _lineStart;
            state.lineIndent = _lineIndent;
            break;
          }
        }
        if (hasPendingContent) {
          captureSegment(state, captureStart, captureEnd, false);
          writeFoldedLines(state, state.line - _line);
          captureStart = captureEnd = state.position;
          hasPendingContent = false;
        }
        if (!is_WHITE_SPACE(ch)) {
          captureEnd = state.position + 1;
        }
        ch = state.input.charCodeAt(++state.position);
      }
      captureSegment(state, captureStart, captureEnd, false);
      if (state.result) {
        return true;
      }
      state.kind = _kind;
      state.result = _result;
      return false;
    }
    function readSingleQuotedScalar(state, nodeIndent) {
      var ch, captureStart, captureEnd;
      ch = state.input.charCodeAt(state.position);
      if (ch !== 39) {
        return false;
      }
      state.kind = "scalar";
      state.result = "";
      state.position++;
      captureStart = captureEnd = state.position;
      while ((ch = state.input.charCodeAt(state.position)) !== 0) {
        if (ch === 39) {
          captureSegment(state, captureStart, state.position, true);
          ch = state.input.charCodeAt(++state.position);
          if (ch === 39) {
            captureStart = state.position;
            state.position++;
            captureEnd = state.position;
          } else {
            return true;
          }
        } else if (is_EOL(ch)) {
          captureSegment(state, captureStart, captureEnd, true);
          writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
          captureStart = captureEnd = state.position;
        } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
          throwError(state, "unexpected end of the document within a single quoted scalar");
        } else {
          state.position++;
          captureEnd = state.position;
        }
      }
      throwError(state, "unexpected end of the stream within a single quoted scalar");
    }
    function readDoubleQuotedScalar(state, nodeIndent) {
      var captureStart, captureEnd, hexLength, hexResult, tmp, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch !== 34) {
        return false;
      }
      state.kind = "scalar";
      state.result = "";
      state.position++;
      captureStart = captureEnd = state.position;
      while ((ch = state.input.charCodeAt(state.position)) !== 0) {
        if (ch === 34) {
          captureSegment(state, captureStart, state.position, true);
          state.position++;
          return true;
        } else if (ch === 92) {
          captureSegment(state, captureStart, state.position, true);
          ch = state.input.charCodeAt(++state.position);
          if (is_EOL(ch)) {
            skipSeparationSpace(state, false, nodeIndent);
          } else if (ch < 256 && simpleEscapeCheck[ch]) {
            state.result += simpleEscapeMap[ch];
            state.position++;
          } else if ((tmp = escapedHexLen(ch)) > 0) {
            hexLength = tmp;
            hexResult = 0;
            for (; hexLength > 0; hexLength--) {
              ch = state.input.charCodeAt(++state.position);
              if ((tmp = fromHexCode(ch)) >= 0) {
                hexResult = (hexResult << 4) + tmp;
              } else {
                throwError(state, "expected hexadecimal character");
              }
            }
            state.result += charFromCodepoint(hexResult);
            state.position++;
          } else {
            throwError(state, "unknown escape sequence");
          }
          captureStart = captureEnd = state.position;
        } else if (is_EOL(ch)) {
          captureSegment(state, captureStart, captureEnd, true);
          writeFoldedLines(state, skipSeparationSpace(state, false, nodeIndent));
          captureStart = captureEnd = state.position;
        } else if (state.position === state.lineStart && testDocumentSeparator(state)) {
          throwError(state, "unexpected end of the document within a double quoted scalar");
        } else {
          state.position++;
          captureEnd = state.position;
        }
      }
      throwError(state, "unexpected end of the stream within a double quoted scalar");
    }
    function readFlowCollection(state, nodeIndent) {
      var readNext = true, _line, _tag = state.tag, _result, _anchor = state.anchor, following, terminator, isPair, isExplicitPair, isMapping, overridableKeys = {}, keyNode, keyTag, valueNode, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch === 91) {
        terminator = 93;
        isMapping = false;
        _result = [];
      } else if (ch === 123) {
        terminator = 125;
        isMapping = true;
        _result = {};
      } else {
        return false;
      }
      if (state.anchor !== null) {
        state.anchorMap[state.anchor] = _result;
      }
      ch = state.input.charCodeAt(++state.position);
      while (ch !== 0) {
        skipSeparationSpace(state, true, nodeIndent);
        ch = state.input.charCodeAt(state.position);
        if (ch === terminator) {
          state.position++;
          state.tag = _tag;
          state.anchor = _anchor;
          state.kind = isMapping ? "mapping" : "sequence";
          state.result = _result;
          return true;
        } else if (!readNext) {
          throwError(state, "missed comma between flow collection entries");
        }
        keyTag = keyNode = valueNode = null;
        isPair = isExplicitPair = false;
        if (ch === 63) {
          following = state.input.charCodeAt(state.position + 1);
          if (is_WS_OR_EOL(following)) {
            isPair = isExplicitPair = true;
            state.position++;
            skipSeparationSpace(state, true, nodeIndent);
          }
        }
        _line = state.line;
        composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
        keyTag = state.tag;
        keyNode = state.result;
        skipSeparationSpace(state, true, nodeIndent);
        ch = state.input.charCodeAt(state.position);
        if ((isExplicitPair || state.line === _line) && ch === 58) {
          isPair = true;
          ch = state.input.charCodeAt(++state.position);
          skipSeparationSpace(state, true, nodeIndent);
          composeNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
          valueNode = state.result;
        }
        if (isMapping) {
          storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode);
        } else if (isPair) {
          _result.push(storeMappingPair(state, null, overridableKeys, keyTag, keyNode, valueNode));
        } else {
          _result.push(keyNode);
        }
        skipSeparationSpace(state, true, nodeIndent);
        ch = state.input.charCodeAt(state.position);
        if (ch === 44) {
          readNext = true;
          ch = state.input.charCodeAt(++state.position);
        } else {
          readNext = false;
        }
      }
      throwError(state, "unexpected end of the stream within a flow collection");
    }
    function readBlockScalar(state, nodeIndent) {
      var captureStart, folding, chomping = CHOMPING_CLIP, didReadContent = false, detectedIndent = false, textIndent = nodeIndent, emptyLines = 0, atMoreIndented = false, tmp, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch === 124) {
        folding = false;
      } else if (ch === 62) {
        folding = true;
      } else {
        return false;
      }
      state.kind = "scalar";
      state.result = "";
      while (ch !== 0) {
        ch = state.input.charCodeAt(++state.position);
        if (ch === 43 || ch === 45) {
          if (CHOMPING_CLIP === chomping) {
            chomping = ch === 43 ? CHOMPING_KEEP : CHOMPING_STRIP;
          } else {
            throwError(state, "repeat of a chomping mode identifier");
          }
        } else if ((tmp = fromDecimalCode(ch)) >= 0) {
          if (tmp === 0) {
            throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
          } else if (!detectedIndent) {
            textIndent = nodeIndent + tmp - 1;
            detectedIndent = true;
          } else {
            throwError(state, "repeat of an indentation width identifier");
          }
        } else {
          break;
        }
      }
      if (is_WHITE_SPACE(ch)) {
        do {
          ch = state.input.charCodeAt(++state.position);
        } while (is_WHITE_SPACE(ch));
        if (ch === 35) {
          do {
            ch = state.input.charCodeAt(++state.position);
          } while (!is_EOL(ch) && ch !== 0);
        }
      }
      while (ch !== 0) {
        readLineBreak(state);
        state.lineIndent = 0;
        ch = state.input.charCodeAt(state.position);
        while ((!detectedIndent || state.lineIndent < textIndent) && ch === 32) {
          state.lineIndent++;
          ch = state.input.charCodeAt(++state.position);
        }
        if (!detectedIndent && state.lineIndent > textIndent) {
          textIndent = state.lineIndent;
        }
        if (is_EOL(ch)) {
          emptyLines++;
          continue;
        }
        if (state.lineIndent < textIndent) {
          if (chomping === CHOMPING_KEEP) {
            state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
          } else if (chomping === CHOMPING_CLIP) {
            if (didReadContent) {
              state.result += "\n";
            }
          }
          break;
        }
        if (folding) {
          if (is_WHITE_SPACE(ch)) {
            atMoreIndented = true;
            state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
          } else if (atMoreIndented) {
            atMoreIndented = false;
            state.result += common.repeat("\n", emptyLines + 1);
          } else if (emptyLines === 0) {
            if (didReadContent) {
              state.result += " ";
            }
          } else {
            state.result += common.repeat("\n", emptyLines);
          }
        } else {
          state.result += common.repeat("\n", didReadContent ? 1 + emptyLines : emptyLines);
        }
        didReadContent = true;
        detectedIndent = true;
        emptyLines = 0;
        captureStart = state.position;
        while (!is_EOL(ch) && ch !== 0) {
          ch = state.input.charCodeAt(++state.position);
        }
        captureSegment(state, captureStart, state.position, false);
      }
      return true;
    }
    function readBlockSequence(state, nodeIndent) {
      var _line, _tag = state.tag, _anchor = state.anchor, _result = [], following, detected = false, ch;
      if (state.anchor !== null) {
        state.anchorMap[state.anchor] = _result;
      }
      ch = state.input.charCodeAt(state.position);
      while (ch !== 0) {
        if (ch !== 45) {
          break;
        }
        following = state.input.charCodeAt(state.position + 1);
        if (!is_WS_OR_EOL(following)) {
          break;
        }
        detected = true;
        state.position++;
        if (skipSeparationSpace(state, true, -1)) {
          if (state.lineIndent <= nodeIndent) {
            _result.push(null);
            ch = state.input.charCodeAt(state.position);
            continue;
          }
        }
        _line = state.line;
        composeNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
        _result.push(state.result);
        skipSeparationSpace(state, true, -1);
        ch = state.input.charCodeAt(state.position);
        if ((state.line === _line || state.lineIndent > nodeIndent) && ch !== 0) {
          throwError(state, "bad indentation of a sequence entry");
        } else if (state.lineIndent < nodeIndent) {
          break;
        }
      }
      if (detected) {
        state.tag = _tag;
        state.anchor = _anchor;
        state.kind = "sequence";
        state.result = _result;
        return true;
      }
      return false;
    }
    function readBlockMapping(state, nodeIndent, flowIndent) {
      var following, allowCompact, _line, _pos, _tag = state.tag, _anchor = state.anchor, _result = {}, overridableKeys = {}, keyTag = null, keyNode = null, valueNode = null, atExplicitKey = false, detected = false, ch;
      if (state.anchor !== null) {
        state.anchorMap[state.anchor] = _result;
      }
      ch = state.input.charCodeAt(state.position);
      while (ch !== 0) {
        following = state.input.charCodeAt(state.position + 1);
        _line = state.line;
        _pos = state.position;
        if ((ch === 63 || ch === 58) && is_WS_OR_EOL(following)) {
          if (ch === 63) {
            if (atExplicitKey) {
              storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null);
              keyTag = keyNode = valueNode = null;
            }
            detected = true;
            atExplicitKey = true;
            allowCompact = true;
          } else if (atExplicitKey) {
            atExplicitKey = false;
            allowCompact = true;
          } else {
            throwError(state, "incomplete explicit mapping pair; a key node is missed; or followed by a non-tabulated empty line");
          }
          state.position += 1;
          ch = following;
        } else if (composeNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) {
          if (state.line === _line) {
            ch = state.input.charCodeAt(state.position);
            while (is_WHITE_SPACE(ch)) {
              ch = state.input.charCodeAt(++state.position);
            }
            if (ch === 58) {
              ch = state.input.charCodeAt(++state.position);
              if (!is_WS_OR_EOL(ch)) {
                throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
              }
              if (atExplicitKey) {
                storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null);
                keyTag = keyNode = valueNode = null;
              }
              detected = true;
              atExplicitKey = false;
              allowCompact = false;
              keyTag = state.tag;
              keyNode = state.result;
            } else if (detected) {
              throwError(state, "can not read an implicit mapping pair; a colon is missed");
            } else {
              state.tag = _tag;
              state.anchor = _anchor;
              return true;
            }
          } else if (detected) {
            throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
          } else {
            state.tag = _tag;
            state.anchor = _anchor;
            return true;
          }
        } else {
          break;
        }
        if (state.line === _line || state.lineIndent > nodeIndent) {
          if (composeNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, allowCompact)) {
            if (atExplicitKey) {
              keyNode = state.result;
            } else {
              valueNode = state.result;
            }
          }
          if (!atExplicitKey) {
            storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, valueNode, _line, _pos);
            keyTag = keyNode = valueNode = null;
          }
          skipSeparationSpace(state, true, -1);
          ch = state.input.charCodeAt(state.position);
        }
        if (state.lineIndent > nodeIndent && ch !== 0) {
          throwError(state, "bad indentation of a mapping entry");
        } else if (state.lineIndent < nodeIndent) {
          break;
        }
      }
      if (atExplicitKey) {
        storeMappingPair(state, _result, overridableKeys, keyTag, keyNode, null);
      }
      if (detected) {
        state.tag = _tag;
        state.anchor = _anchor;
        state.kind = "mapping";
        state.result = _result;
      }
      return detected;
    }
    function readTagProperty(state) {
      var _position, isVerbatim = false, isNamed = false, tagHandle, tagName, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch !== 33) return false;
      if (state.tag !== null) {
        throwError(state, "duplication of a tag property");
      }
      ch = state.input.charCodeAt(++state.position);
      if (ch === 60) {
        isVerbatim = true;
        ch = state.input.charCodeAt(++state.position);
      } else if (ch === 33) {
        isNamed = true;
        tagHandle = "!!";
        ch = state.input.charCodeAt(++state.position);
      } else {
        tagHandle = "!";
      }
      _position = state.position;
      if (isVerbatim) {
        do {
          ch = state.input.charCodeAt(++state.position);
        } while (ch !== 0 && ch !== 62);
        if (state.position < state.length) {
          tagName = state.input.slice(_position, state.position);
          ch = state.input.charCodeAt(++state.position);
        } else {
          throwError(state, "unexpected end of the stream within a verbatim tag");
        }
      } else {
        while (ch !== 0 && !is_WS_OR_EOL(ch)) {
          if (ch === 33) {
            if (!isNamed) {
              tagHandle = state.input.slice(_position - 1, state.position + 1);
              if (!PATTERN_TAG_HANDLE.test(tagHandle)) {
                throwError(state, "named tag handle cannot contain such characters");
              }
              isNamed = true;
              _position = state.position + 1;
            } else {
              throwError(state, "tag suffix cannot contain exclamation marks");
            }
          }
          ch = state.input.charCodeAt(++state.position);
        }
        tagName = state.input.slice(_position, state.position);
        if (PATTERN_FLOW_INDICATORS.test(tagName)) {
          throwError(state, "tag suffix cannot contain flow indicator characters");
        }
      }
      if (tagName && !PATTERN_TAG_URI.test(tagName)) {
        throwError(state, "tag name cannot contain such characters: " + tagName);
      }
      if (isVerbatim) {
        state.tag = tagName;
      } else if (_hasOwnProperty.call(state.tagMap, tagHandle)) {
        state.tag = state.tagMap[tagHandle] + tagName;
      } else if (tagHandle === "!") {
        state.tag = "!" + tagName;
      } else if (tagHandle === "!!") {
        state.tag = "tag:yaml.org,2002:" + tagName;
      } else {
        throwError(state, 'undeclared tag handle "' + tagHandle + '"');
      }
      return true;
    }
    function readAnchorProperty(state) {
      var _position, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch !== 38) return false;
      if (state.anchor !== null) {
        throwError(state, "duplication of an anchor property");
      }
      ch = state.input.charCodeAt(++state.position);
      _position = state.position;
      while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }
      if (state.position === _position) {
        throwError(state, "name of an anchor node must contain at least one character");
      }
      state.anchor = state.input.slice(_position, state.position);
      return true;
    }
    function readAlias(state) {
      var _position, alias, ch;
      ch = state.input.charCodeAt(state.position);
      if (ch !== 42) return false;
      ch = state.input.charCodeAt(++state.position);
      _position = state.position;
      while (ch !== 0 && !is_WS_OR_EOL(ch) && !is_FLOW_INDICATOR(ch)) {
        ch = state.input.charCodeAt(++state.position);
      }
      if (state.position === _position) {
        throwError(state, "name of an alias node must contain at least one character");
      }
      alias = state.input.slice(_position, state.position);
      if (!_hasOwnProperty.call(state.anchorMap, alias)) {
        throwError(state, 'unidentified alias "' + alias + '"');
      }
      state.result = state.anchorMap[alias];
      skipSeparationSpace(state, true, -1);
      return true;
    }
    function composeNode(state, parentIndent, nodeContext, allowToSeek, allowCompact) {
      var allowBlockStyles, allowBlockScalars, allowBlockCollections, indentStatus = 1, atNewLine = false, hasContent = false, typeIndex, typeQuantity, type, flowIndent, blockIndent;
      if (state.listener !== null) {
        state.listener("open", state);
      }
      state.tag = null;
      state.anchor = null;
      state.kind = null;
      state.result = null;
      allowBlockStyles = allowBlockScalars = allowBlockCollections = CONTEXT_BLOCK_OUT === nodeContext || CONTEXT_BLOCK_IN === nodeContext;
      if (allowToSeek) {
        if (skipSeparationSpace(state, true, -1)) {
          atNewLine = true;
          if (state.lineIndent > parentIndent) {
            indentStatus = 1;
          } else if (state.lineIndent === parentIndent) {
            indentStatus = 0;
          } else if (state.lineIndent < parentIndent) {
            indentStatus = -1;
          }
        }
      }
      if (indentStatus === 1) {
        while (readTagProperty(state) || readAnchorProperty(state)) {
          if (skipSeparationSpace(state, true, -1)) {
            atNewLine = true;
            allowBlockCollections = allowBlockStyles;
            if (state.lineIndent > parentIndent) {
              indentStatus = 1;
            } else if (state.lineIndent === parentIndent) {
              indentStatus = 0;
            } else if (state.lineIndent < parentIndent) {
              indentStatus = -1;
            }
          } else {
            allowBlockCollections = false;
          }
        }
      }
      if (allowBlockCollections) {
        allowBlockCollections = atNewLine || allowCompact;
      }
      if (indentStatus === 1 || CONTEXT_BLOCK_OUT === nodeContext) {
        if (CONTEXT_FLOW_IN === nodeContext || CONTEXT_FLOW_OUT === nodeContext) {
          flowIndent = parentIndent;
        } else {
          flowIndent = parentIndent + 1;
        }
        blockIndent = state.position - state.lineStart;
        if (indentStatus === 1) {
          if (allowBlockCollections && (readBlockSequence(state, blockIndent) || readBlockMapping(state, blockIndent, flowIndent)) || readFlowCollection(state, flowIndent)) {
            hasContent = true;
          } else {
            if (allowBlockScalars && readBlockScalar(state, flowIndent) || readSingleQuotedScalar(state, flowIndent) || readDoubleQuotedScalar(state, flowIndent)) {
              hasContent = true;
            } else if (readAlias(state)) {
              hasContent = true;
              if (state.tag !== null || state.anchor !== null) {
                throwError(state, "alias node should not have any properties");
              }
            } else if (readPlainScalar(state, flowIndent, CONTEXT_FLOW_IN === nodeContext)) {
              hasContent = true;
              if (state.tag === null) {
                state.tag = "?";
              }
            }
            if (state.anchor !== null) {
              state.anchorMap[state.anchor] = state.result;
            }
          }
        } else if (indentStatus === 0) {
          hasContent = allowBlockCollections && readBlockSequence(state, blockIndent);
        }
      }
      if (state.tag !== null && state.tag !== "!") {
        if (state.tag === "?") {
          if (state.result !== null && state.kind !== "scalar") {
            throwError(state, 'unacceptable node kind for !<?> tag; it should be "scalar", not "' + state.kind + '"');
          }
          for (typeIndex = 0, typeQuantity = state.implicitTypes.length; typeIndex < typeQuantity; typeIndex += 1) {
            type = state.implicitTypes[typeIndex];
            if (type.resolve(state.result)) {
              state.result = type.construct(state.result);
              state.tag = type.tag;
              if (state.anchor !== null) {
                state.anchorMap[state.anchor] = state.result;
              }
              break;
            }
          }
        } else if (_hasOwnProperty.call(state.typeMap[state.kind || "fallback"], state.tag)) {
          type = state.typeMap[state.kind || "fallback"][state.tag];
          if (state.result !== null && type.kind !== state.kind) {
            throwError(state, "unacceptable node kind for !<" + state.tag + '> tag; it should be "' + type.kind + '", not "' + state.kind + '"');
          }
          if (!type.resolve(state.result)) {
            throwError(state, "cannot resolve a node with !<" + state.tag + "> explicit tag");
          } else {
            state.result = type.construct(state.result);
            if (state.anchor !== null) {
              state.anchorMap[state.anchor] = state.result;
            }
          }
        } else {
          throwError(state, "unknown tag !<" + state.tag + ">");
        }
      }
      if (state.listener !== null) {
        state.listener("close", state);
      }
      return state.tag !== null || state.anchor !== null || hasContent;
    }
    function readDocument(state) {
      var documentStart = state.position, _position, directiveName, directiveArgs, hasDirectives = false, ch;
      state.version = null;
      state.checkLineBreaks = state.legacy;
      state.tagMap = {};
      state.anchorMap = {};
      while ((ch = state.input.charCodeAt(state.position)) !== 0) {
        skipSeparationSpace(state, true, -1);
        ch = state.input.charCodeAt(state.position);
        if (state.lineIndent > 0 || ch !== 37) {
          break;
        }
        hasDirectives = true;
        ch = state.input.charCodeAt(++state.position);
        _position = state.position;
        while (ch !== 0 && !is_WS_OR_EOL(ch)) {
          ch = state.input.charCodeAt(++state.position);
        }
        directiveName = state.input.slice(_position, state.position);
        directiveArgs = [];
        if (directiveName.length < 1) {
          throwError(state, "directive name must not be less than one character in length");
        }
        while (ch !== 0) {
          while (is_WHITE_SPACE(ch)) {
            ch = state.input.charCodeAt(++state.position);
          }
          if (ch === 35) {
            do {
              ch = state.input.charCodeAt(++state.position);
            } while (ch !== 0 && !is_EOL(ch));
            break;
          }
          if (is_EOL(ch)) break;
          _position = state.position;
          while (ch !== 0 && !is_WS_OR_EOL(ch)) {
            ch = state.input.charCodeAt(++state.position);
          }
          directiveArgs.push(state.input.slice(_position, state.position));
        }
        if (ch !== 0) readLineBreak(state);
        if (_hasOwnProperty.call(directiveHandlers, directiveName)) {
          directiveHandlers[directiveName](state, directiveName, directiveArgs);
        } else {
          throwWarning(state, 'unknown document directive "' + directiveName + '"');
        }
      }
      skipSeparationSpace(state, true, -1);
      if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45) {
        state.position += 3;
        skipSeparationSpace(state, true, -1);
      } else if (hasDirectives) {
        throwError(state, "directives end mark is expected");
      }
      composeNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, true);
      skipSeparationSpace(state, true, -1);
      if (state.checkLineBreaks && PATTERN_NON_ASCII_LINE_BREAKS.test(state.input.slice(documentStart, state.position))) {
        throwWarning(state, "non-ASCII line breaks are interpreted as content");
      }
      state.documents.push(state.result);
      if (state.position === state.lineStart && testDocumentSeparator(state)) {
        if (state.input.charCodeAt(state.position) === 46) {
          state.position += 3;
          skipSeparationSpace(state, true, -1);
        }
        return;
      }
      if (state.position < state.length - 1) {
        throwError(state, "end of the stream or a document separator is expected");
      } else {
        return;
      }
    }
    function loadDocuments(input, options2) {
      input = String(input);
      options2 = options2 || {};
      if (input.length !== 0) {
        if (input.charCodeAt(input.length - 1) !== 10 && input.charCodeAt(input.length - 1) !== 13) {
          input += "\n";
        }
        if (input.charCodeAt(0) === 65279) {
          input = input.slice(1);
        }
      }
      var state = new State(input, options2);
      var nullpos = input.indexOf("\0");
      if (nullpos !== -1) {
        state.position = nullpos;
        throwError(state, "null byte is not allowed in input");
      }
      state.input += "\0";
      while (state.input.charCodeAt(state.position) === 32) {
        state.lineIndent += 1;
        state.position += 1;
      }
      while (state.position < state.length - 1) {
        readDocument(state);
      }
      return state.documents;
    }
    function loadAll(input, iterator, options2) {
      if (iterator !== null && typeof iterator === "object" && typeof options2 === "undefined") {
        options2 = iterator;
        iterator = null;
      }
      var documents = loadDocuments(input, options2);
      if (typeof iterator !== "function") {
        return documents;
      }
      for (var index = 0, length = documents.length; index < length; index += 1) {
        iterator(documents[index]);
      }
    }
    function load(input, options2) {
      var documents = loadDocuments(input, options2);
      if (documents.length === 0) {
        return void 0;
      } else if (documents.length === 1) {
        return documents[0];
      }
      throw new YAMLException("expected a single document in the stream, but found more");
    }
    function safeLoadAll(input, iterator, options2) {
      if (typeof iterator === "object" && iterator !== null && typeof options2 === "undefined") {
        options2 = iterator;
        iterator = null;
      }
      return loadAll(input, iterator, common.extend({ schema: DEFAULT_SAFE_SCHEMA }, options2));
    }
    function safeLoad(input, options2) {
      return load(input, common.extend({ schema: DEFAULT_SAFE_SCHEMA }, options2));
    }
    module2.exports.loadAll = loadAll;
    module2.exports.load = load;
    module2.exports.safeLoadAll = safeLoadAll;
    module2.exports.safeLoad = safeLoad;
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/dumper.js
var require_dumper = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml/dumper.js"(exports2, module2) {
    "use strict";
    var common = require_common();
    var YAMLException = require_exception();
    var DEFAULT_FULL_SCHEMA = require_default_full();
    var DEFAULT_SAFE_SCHEMA = require_default_safe();
    var _toString = Object.prototype.toString;
    var _hasOwnProperty = Object.prototype.hasOwnProperty;
    var CHAR_TAB = 9;
    var CHAR_LINE_FEED = 10;
    var CHAR_CARRIAGE_RETURN = 13;
    var CHAR_SPACE = 32;
    var CHAR_EXCLAMATION = 33;
    var CHAR_DOUBLE_QUOTE = 34;
    var CHAR_SHARP = 35;
    var CHAR_PERCENT = 37;
    var CHAR_AMPERSAND = 38;
    var CHAR_SINGLE_QUOTE = 39;
    var CHAR_ASTERISK = 42;
    var CHAR_COMMA = 44;
    var CHAR_MINUS = 45;
    var CHAR_COLON = 58;
    var CHAR_EQUALS = 61;
    var CHAR_GREATER_THAN = 62;
    var CHAR_QUESTION = 63;
    var CHAR_COMMERCIAL_AT = 64;
    var CHAR_LEFT_SQUARE_BRACKET = 91;
    var CHAR_RIGHT_SQUARE_BRACKET = 93;
    var CHAR_GRAVE_ACCENT = 96;
    var CHAR_LEFT_CURLY_BRACKET = 123;
    var CHAR_VERTICAL_LINE = 124;
    var CHAR_RIGHT_CURLY_BRACKET = 125;
    var ESCAPE_SEQUENCES = {};
    ESCAPE_SEQUENCES[0] = "\\0";
    ESCAPE_SEQUENCES[7] = "\\a";
    ESCAPE_SEQUENCES[8] = "\\b";
    ESCAPE_SEQUENCES[9] = "\\t";
    ESCAPE_SEQUENCES[10] = "\\n";
    ESCAPE_SEQUENCES[11] = "\\v";
    ESCAPE_SEQUENCES[12] = "\\f";
    ESCAPE_SEQUENCES[13] = "\\r";
    ESCAPE_SEQUENCES[27] = "\\e";
    ESCAPE_SEQUENCES[34] = '\\"';
    ESCAPE_SEQUENCES[92] = "\\\\";
    ESCAPE_SEQUENCES[133] = "\\N";
    ESCAPE_SEQUENCES[160] = "\\_";
    ESCAPE_SEQUENCES[8232] = "\\L";
    ESCAPE_SEQUENCES[8233] = "\\P";
    var DEPRECATED_BOOLEANS_SYNTAX = [
      "y",
      "Y",
      "yes",
      "Yes",
      "YES",
      "on",
      "On",
      "ON",
      "n",
      "N",
      "no",
      "No",
      "NO",
      "off",
      "Off",
      "OFF"
    ];
    function compileStyleMap(schema, map) {
      var result, keys, index, length, tag, style, type;
      if (map === null) return {};
      result = {};
      keys = Object.keys(map);
      for (index = 0, length = keys.length; index < length; index += 1) {
        tag = keys[index];
        style = String(map[tag]);
        if (tag.slice(0, 2) === "!!") {
          tag = "tag:yaml.org,2002:" + tag.slice(2);
        }
        type = schema.compiledTypeMap["fallback"][tag];
        if (type && _hasOwnProperty.call(type.styleAliases, style)) {
          style = type.styleAliases[style];
        }
        result[tag] = style;
      }
      return result;
    }
    function encodeHex(character) {
      var string, handle, length;
      string = character.toString(16).toUpperCase();
      if (character <= 255) {
        handle = "x";
        length = 2;
      } else if (character <= 65535) {
        handle = "u";
        length = 4;
      } else if (character <= 4294967295) {
        handle = "U";
        length = 8;
      } else {
        throw new YAMLException("code point within a string may not be greater than 0xFFFFFFFF");
      }
      return "\\" + handle + common.repeat("0", length - string.length) + string;
    }
    function State(options2) {
      this.schema = options2["schema"] || DEFAULT_FULL_SCHEMA;
      this.indent = Math.max(1, options2["indent"] || 2);
      this.noArrayIndent = options2["noArrayIndent"] || false;
      this.skipInvalid = options2["skipInvalid"] || false;
      this.flowLevel = common.isNothing(options2["flowLevel"]) ? -1 : options2["flowLevel"];
      this.styleMap = compileStyleMap(this.schema, options2["styles"] || null);
      this.sortKeys = options2["sortKeys"] || false;
      this.lineWidth = options2["lineWidth"] || 80;
      this.noRefs = options2["noRefs"] || false;
      this.noCompatMode = options2["noCompatMode"] || false;
      this.condenseFlow = options2["condenseFlow"] || false;
      this.implicitTypes = this.schema.compiledImplicit;
      this.explicitTypes = this.schema.compiledExplicit;
      this.tag = null;
      this.result = "";
      this.duplicates = [];
      this.usedDuplicates = null;
    }
    function indentString(string, spaces) {
      var ind = common.repeat(" ", spaces), position = 0, next = -1, result = "", line, length = string.length;
      while (position < length) {
        next = string.indexOf("\n", position);
        if (next === -1) {
          line = string.slice(position);
          position = length;
        } else {
          line = string.slice(position, next + 1);
          position = next + 1;
        }
        if (line.length && line !== "\n") result += ind;
        result += line;
      }
      return result;
    }
    function generateNextLine(state, level) {
      return "\n" + common.repeat(" ", state.indent * level);
    }
    function testImplicitResolving(state, str2) {
      var index, length, type;
      for (index = 0, length = state.implicitTypes.length; index < length; index += 1) {
        type = state.implicitTypes[index];
        if (type.resolve(str2)) {
          return true;
        }
      }
      return false;
    }
    function isWhitespace(c) {
      return c === CHAR_SPACE || c === CHAR_TAB;
    }
    function isPrintable(c) {
      return 32 <= c && c <= 126 || 161 <= c && c <= 55295 && c !== 8232 && c !== 8233 || 57344 <= c && c <= 65533 && c !== 65279 || 65536 <= c && c <= 1114111;
    }
    function isNsChar(c) {
      return isPrintable(c) && !isWhitespace(c) && c !== 65279 && c !== CHAR_CARRIAGE_RETURN && c !== CHAR_LINE_FEED;
    }
    function isPlainSafe(c, prev) {
      return isPrintable(c) && c !== 65279 && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET && c !== CHAR_COLON && (c !== CHAR_SHARP || prev && isNsChar(prev));
    }
    function isPlainSafeFirst(c) {
      return isPrintable(c) && c !== 65279 && !isWhitespace(c) && c !== CHAR_MINUS && c !== CHAR_QUESTION && c !== CHAR_COLON && c !== CHAR_COMMA && c !== CHAR_LEFT_SQUARE_BRACKET && c !== CHAR_RIGHT_SQUARE_BRACKET && c !== CHAR_LEFT_CURLY_BRACKET && c !== CHAR_RIGHT_CURLY_BRACKET && c !== CHAR_SHARP && c !== CHAR_AMPERSAND && c !== CHAR_ASTERISK && c !== CHAR_EXCLAMATION && c !== CHAR_VERTICAL_LINE && c !== CHAR_EQUALS && c !== CHAR_GREATER_THAN && c !== CHAR_SINGLE_QUOTE && c !== CHAR_DOUBLE_QUOTE && c !== CHAR_PERCENT && c !== CHAR_COMMERCIAL_AT && c !== CHAR_GRAVE_ACCENT;
    }
    function needIndentIndicator(string) {
      var leadingSpaceRe = /^\n* /;
      return leadingSpaceRe.test(string);
    }
    var STYLE_PLAIN = 1;
    var STYLE_SINGLE = 2;
    var STYLE_LITERAL = 3;
    var STYLE_FOLDED = 4;
    var STYLE_DOUBLE = 5;
    function chooseScalarStyle(string, singleLineOnly, indentPerLevel, lineWidth, testAmbiguousType) {
      var i;
      var char, prev_char;
      var hasLineBreak = false;
      var hasFoldableLine = false;
      var shouldTrackWidth = lineWidth !== -1;
      var previousLineBreak = -1;
      var plain = isPlainSafeFirst(string.charCodeAt(0)) && !isWhitespace(string.charCodeAt(string.length - 1));
      if (singleLineOnly) {
        for (i = 0; i < string.length; i++) {
          char = string.charCodeAt(i);
          if (!isPrintable(char)) {
            return STYLE_DOUBLE;
          }
          prev_char = i > 0 ? string.charCodeAt(i - 1) : null;
          plain = plain && isPlainSafe(char, prev_char);
        }
      } else {
        for (i = 0; i < string.length; i++) {
          char = string.charCodeAt(i);
          if (char === CHAR_LINE_FEED) {
            hasLineBreak = true;
            if (shouldTrackWidth) {
              hasFoldableLine = hasFoldableLine || // Foldable line = too long, and not more-indented.
              i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ";
              previousLineBreak = i;
            }
          } else if (!isPrintable(char)) {
            return STYLE_DOUBLE;
          }
          prev_char = i > 0 ? string.charCodeAt(i - 1) : null;
          plain = plain && isPlainSafe(char, prev_char);
        }
        hasFoldableLine = hasFoldableLine || shouldTrackWidth && (i - previousLineBreak - 1 > lineWidth && string[previousLineBreak + 1] !== " ");
      }
      if (!hasLineBreak && !hasFoldableLine) {
        return plain && !testAmbiguousType(string) ? STYLE_PLAIN : STYLE_SINGLE;
      }
      if (indentPerLevel > 9 && needIndentIndicator(string)) {
        return STYLE_DOUBLE;
      }
      return hasFoldableLine ? STYLE_FOLDED : STYLE_LITERAL;
    }
    function writeScalar(state, string, level, iskey) {
      state.dump = (function() {
        if (string.length === 0) {
          return "''";
        }
        if (!state.noCompatMode && DEPRECATED_BOOLEANS_SYNTAX.indexOf(string) !== -1) {
          return "'" + string + "'";
        }
        var indent = state.indent * Math.max(1, level);
        var lineWidth = state.lineWidth === -1 ? -1 : Math.max(Math.min(state.lineWidth, 40), state.lineWidth - indent);
        var singleLineOnly = iskey || state.flowLevel > -1 && level >= state.flowLevel;
        function testAmbiguity(string2) {
          return testImplicitResolving(state, string2);
        }
        switch (chooseScalarStyle(string, singleLineOnly, state.indent, lineWidth, testAmbiguity)) {
          case STYLE_PLAIN:
            return string;
          case STYLE_SINGLE:
            return "'" + string.replace(/'/g, "''") + "'";
          case STYLE_LITERAL:
            return "|" + blockHeader(string, state.indent) + dropEndingNewline(indentString(string, indent));
          case STYLE_FOLDED:
            return ">" + blockHeader(string, state.indent) + dropEndingNewline(indentString(foldString(string, lineWidth), indent));
          case STYLE_DOUBLE:
            return '"' + escapeString(string, lineWidth) + '"';
          default:
            throw new YAMLException("impossible error: invalid scalar style");
        }
      })();
    }
    function blockHeader(string, indentPerLevel) {
      var indentIndicator = needIndentIndicator(string) ? String(indentPerLevel) : "";
      var clip = string[string.length - 1] === "\n";
      var keep = clip && (string[string.length - 2] === "\n" || string === "\n");
      var chomp = keep ? "+" : clip ? "" : "-";
      return indentIndicator + chomp + "\n";
    }
    function dropEndingNewline(string) {
      return string[string.length - 1] === "\n" ? string.slice(0, -1) : string;
    }
    function foldString(string, width) {
      var lineRe = /(\n+)([^\n]*)/g;
      var result = (function() {
        var nextLF = string.indexOf("\n");
        nextLF = nextLF !== -1 ? nextLF : string.length;
        lineRe.lastIndex = nextLF;
        return foldLine(string.slice(0, nextLF), width);
      })();
      var prevMoreIndented = string[0] === "\n" || string[0] === " ";
      var moreIndented;
      var match;
      while (match = lineRe.exec(string)) {
        var prefix = match[1], line = match[2];
        moreIndented = line[0] === " ";
        result += prefix + (!prevMoreIndented && !moreIndented && line !== "" ? "\n" : "") + foldLine(line, width);
        prevMoreIndented = moreIndented;
      }
      return result;
    }
    function foldLine(line, width) {
      if (line === "" || line[0] === " ") return line;
      var breakRe = / [^ ]/g;
      var match;
      var start = 0, end, curr = 0, next = 0;
      var result = "";
      while (match = breakRe.exec(line)) {
        next = match.index;
        if (next - start > width) {
          end = curr > start ? curr : next;
          result += "\n" + line.slice(start, end);
          start = end + 1;
        }
        curr = next;
      }
      result += "\n";
      if (line.length - start > width && curr > start) {
        result += line.slice(start, curr) + "\n" + line.slice(curr + 1);
      } else {
        result += line.slice(start);
      }
      return result.slice(1);
    }
    function escapeString(string) {
      var result = "";
      var char, nextChar;
      var escapeSeq;
      for (var i = 0; i < string.length; i++) {
        char = string.charCodeAt(i);
        if (char >= 55296 && char <= 56319) {
          nextChar = string.charCodeAt(i + 1);
          if (nextChar >= 56320 && nextChar <= 57343) {
            result += encodeHex((char - 55296) * 1024 + nextChar - 56320 + 65536);
            i++;
            continue;
          }
        }
        escapeSeq = ESCAPE_SEQUENCES[char];
        result += !escapeSeq && isPrintable(char) ? string[i] : escapeSeq || encodeHex(char);
      }
      return result;
    }
    function writeFlowSequence(state, level, object) {
      var _result = "", _tag = state.tag, index, length;
      for (index = 0, length = object.length; index < length; index += 1) {
        if (writeNode(state, level, object[index], false, false)) {
          if (index !== 0) _result += "," + (!state.condenseFlow ? " " : "");
          _result += state.dump;
        }
      }
      state.tag = _tag;
      state.dump = "[" + _result + "]";
    }
    function writeBlockSequence(state, level, object, compact) {
      var _result = "", _tag = state.tag, index, length;
      for (index = 0, length = object.length; index < length; index += 1) {
        if (writeNode(state, level + 1, object[index], true, true)) {
          if (!compact || index !== 0) {
            _result += generateNextLine(state, level);
          }
          if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
            _result += "-";
          } else {
            _result += "- ";
          }
          _result += state.dump;
        }
      }
      state.tag = _tag;
      state.dump = _result || "[]";
    }
    function writeFlowMapping(state, level, object) {
      var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, pairBuffer;
      for (index = 0, length = objectKeyList.length; index < length; index += 1) {
        pairBuffer = "";
        if (index !== 0) pairBuffer += ", ";
        if (state.condenseFlow) pairBuffer += '"';
        objectKey = objectKeyList[index];
        objectValue = object[objectKey];
        if (!writeNode(state, level, objectKey, false, false)) {
          continue;
        }
        if (state.dump.length > 1024) pairBuffer += "? ";
        pairBuffer += state.dump + (state.condenseFlow ? '"' : "") + ":" + (state.condenseFlow ? "" : " ");
        if (!writeNode(state, level, objectValue, false, false)) {
          continue;
        }
        pairBuffer += state.dump;
        _result += pairBuffer;
      }
      state.tag = _tag;
      state.dump = "{" + _result + "}";
    }
    function writeBlockMapping(state, level, object, compact) {
      var _result = "", _tag = state.tag, objectKeyList = Object.keys(object), index, length, objectKey, objectValue, explicitPair, pairBuffer;
      if (state.sortKeys === true) {
        objectKeyList.sort();
      } else if (typeof state.sortKeys === "function") {
        objectKeyList.sort(state.sortKeys);
      } else if (state.sortKeys) {
        throw new YAMLException("sortKeys must be a boolean or a function");
      }
      for (index = 0, length = objectKeyList.length; index < length; index += 1) {
        pairBuffer = "";
        if (!compact || index !== 0) {
          pairBuffer += generateNextLine(state, level);
        }
        objectKey = objectKeyList[index];
        objectValue = object[objectKey];
        if (!writeNode(state, level + 1, objectKey, true, true, true)) {
          continue;
        }
        explicitPair = state.tag !== null && state.tag !== "?" || state.dump && state.dump.length > 1024;
        if (explicitPair) {
          if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
            pairBuffer += "?";
          } else {
            pairBuffer += "? ";
          }
        }
        pairBuffer += state.dump;
        if (explicitPair) {
          pairBuffer += generateNextLine(state, level);
        }
        if (!writeNode(state, level + 1, objectValue, true, explicitPair)) {
          continue;
        }
        if (state.dump && CHAR_LINE_FEED === state.dump.charCodeAt(0)) {
          pairBuffer += ":";
        } else {
          pairBuffer += ": ";
        }
        pairBuffer += state.dump;
        _result += pairBuffer;
      }
      state.tag = _tag;
      state.dump = _result || "{}";
    }
    function detectType(state, object, explicit) {
      var _result, typeList, index, length, type, style;
      typeList = explicit ? state.explicitTypes : state.implicitTypes;
      for (index = 0, length = typeList.length; index < length; index += 1) {
        type = typeList[index];
        if ((type.instanceOf || type.predicate) && (!type.instanceOf || typeof object === "object" && object instanceof type.instanceOf) && (!type.predicate || type.predicate(object))) {
          state.tag = explicit ? type.tag : "?";
          if (type.represent) {
            style = state.styleMap[type.tag] || type.defaultStyle;
            if (_toString.call(type.represent) === "[object Function]") {
              _result = type.represent(object, style);
            } else if (_hasOwnProperty.call(type.represent, style)) {
              _result = type.represent[style](object, style);
            } else {
              throw new YAMLException("!<" + type.tag + '> tag resolver accepts not "' + style + '" style');
            }
            state.dump = _result;
          }
          return true;
        }
      }
      return false;
    }
    function writeNode(state, level, object, block, compact, iskey) {
      state.tag = null;
      state.dump = object;
      if (!detectType(state, object, false)) {
        detectType(state, object, true);
      }
      var type = _toString.call(state.dump);
      if (block) {
        block = state.flowLevel < 0 || state.flowLevel > level;
      }
      var objectOrArray = type === "[object Object]" || type === "[object Array]", duplicateIndex, duplicate;
      if (objectOrArray) {
        duplicateIndex = state.duplicates.indexOf(object);
        duplicate = duplicateIndex !== -1;
      }
      if (state.tag !== null && state.tag !== "?" || duplicate || state.indent !== 2 && level > 0) {
        compact = false;
      }
      if (duplicate && state.usedDuplicates[duplicateIndex]) {
        state.dump = "*ref_" + duplicateIndex;
      } else {
        if (objectOrArray && duplicate && !state.usedDuplicates[duplicateIndex]) {
          state.usedDuplicates[duplicateIndex] = true;
        }
        if (type === "[object Object]") {
          if (block && Object.keys(state.dump).length !== 0) {
            writeBlockMapping(state, level, state.dump, compact);
            if (duplicate) {
              state.dump = "&ref_" + duplicateIndex + state.dump;
            }
          } else {
            writeFlowMapping(state, level, state.dump);
            if (duplicate) {
              state.dump = "&ref_" + duplicateIndex + " " + state.dump;
            }
          }
        } else if (type === "[object Array]") {
          var arrayLevel = state.noArrayIndent && level > 0 ? level - 1 : level;
          if (block && state.dump.length !== 0) {
            writeBlockSequence(state, arrayLevel, state.dump, compact);
            if (duplicate) {
              state.dump = "&ref_" + duplicateIndex + state.dump;
            }
          } else {
            writeFlowSequence(state, arrayLevel, state.dump);
            if (duplicate) {
              state.dump = "&ref_" + duplicateIndex + " " + state.dump;
            }
          }
        } else if (type === "[object String]") {
          if (state.tag !== "?") {
            writeScalar(state, state.dump, level, iskey);
          }
        } else {
          if (state.skipInvalid) return false;
          throw new YAMLException("unacceptable kind of an object to dump " + type);
        }
        if (state.tag !== null && state.tag !== "?") {
          state.dump = "!<" + state.tag + "> " + state.dump;
        }
      }
      return true;
    }
    function getDuplicateReferences(object, state) {
      var objects = [], duplicatesIndexes = [], index, length;
      inspectNode(object, objects, duplicatesIndexes);
      for (index = 0, length = duplicatesIndexes.length; index < length; index += 1) {
        state.duplicates.push(objects[duplicatesIndexes[index]]);
      }
      state.usedDuplicates = new Array(length);
    }
    function inspectNode(object, objects, duplicatesIndexes) {
      var objectKeyList, index, length;
      if (object !== null && typeof object === "object") {
        index = objects.indexOf(object);
        if (index !== -1) {
          if (duplicatesIndexes.indexOf(index) === -1) {
            duplicatesIndexes.push(index);
          }
        } else {
          objects.push(object);
          if (Array.isArray(object)) {
            for (index = 0, length = object.length; index < length; index += 1) {
              inspectNode(object[index], objects, duplicatesIndexes);
            }
          } else {
            objectKeyList = Object.keys(object);
            for (index = 0, length = objectKeyList.length; index < length; index += 1) {
              inspectNode(object[objectKeyList[index]], objects, duplicatesIndexes);
            }
          }
        }
      }
    }
    function dump(input, options2) {
      options2 = options2 || {};
      var state = new State(options2);
      if (!state.noRefs) getDuplicateReferences(input, state);
      if (writeNode(state, 0, input, true, true)) return state.dump + "\n";
      return "";
    }
    function safeDump(input, options2) {
      return dump(input, common.extend({ schema: DEFAULT_SAFE_SCHEMA }, options2));
    }
    module2.exports.dump = dump;
    module2.exports.safeDump = safeDump;
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml.js
var require_js_yaml = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/lib/js-yaml.js"(exports2, module2) {
    "use strict";
    var loader = require_loader();
    var dumper = require_dumper();
    function deprecated(name) {
      return function() {
        throw new Error("Function " + name + " is deprecated and cannot be used.");
      };
    }
    module2.exports.Type = require_type();
    module2.exports.Schema = require_schema();
    module2.exports.FAILSAFE_SCHEMA = require_failsafe();
    module2.exports.JSON_SCHEMA = require_json();
    module2.exports.CORE_SCHEMA = require_core();
    module2.exports.DEFAULT_SAFE_SCHEMA = require_default_safe();
    module2.exports.DEFAULT_FULL_SCHEMA = require_default_full();
    module2.exports.load = loader.load;
    module2.exports.loadAll = loader.loadAll;
    module2.exports.safeLoad = loader.safeLoad;
    module2.exports.safeLoadAll = loader.safeLoadAll;
    module2.exports.dump = dumper.dump;
    module2.exports.safeDump = dumper.safeDump;
    module2.exports.YAMLException = require_exception();
    module2.exports.MINIMAL_SCHEMA = require_failsafe();
    module2.exports.SAFE_SCHEMA = require_default_safe();
    module2.exports.DEFAULT_SCHEMA = require_default_full();
    module2.exports.scan = deprecated("scan");
    module2.exports.parse = deprecated("parse");
    module2.exports.compose = deprecated("compose");
    module2.exports.addConstructor = deprecated("addConstructor");
  }
});

// node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/index.js
var require_js_yaml2 = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.1/node_modules/js-yaml/index.js"(exports2, module2) {
    "use strict";
    var yaml2 = require_js_yaml();
    module2.exports = yaml2;
  }
});

// node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/engines.js
var require_engines = __commonJS({
  "node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/engines.js"(exports, module) {
    "use strict";
    var yaml = require_js_yaml2();
    var engines = exports = module.exports;
    engines.yaml = {
      parse: yaml.safeLoad.bind(yaml),
      stringify: yaml.safeDump.bind(yaml)
    };
    engines.json = {
      parse: JSON.parse.bind(JSON),
      stringify: function(obj, options2) {
        const opts = Object.assign({ replacer: null, space: 2 }, options2);
        return JSON.stringify(obj, opts.replacer, opts.space);
      }
    };
    engines.javascript = {
      parse: function parse(str, options, wrap) {
        try {
          if (wrap !== false) {
            str = "(function() {\nreturn " + str.trim() + ";\n}());";
          }
          return eval(str) || {};
        } catch (err) {
          if (wrap !== false && /(unexpected|identifier)/i.test(err.message)) {
            return parse(str, options, false);
          }
          throw new SyntaxError(err);
        }
      },
      stringify: function() {
        throw new Error("stringifying JavaScript is not supported");
      }
    };
  }
});

// node_modules/.pnpm/strip-bom-string@1.0.0/node_modules/strip-bom-string/index.js
var require_strip_bom_string = __commonJS({
  "node_modules/.pnpm/strip-bom-string@1.0.0/node_modules/strip-bom-string/index.js"(exports2, module2) {
    "use strict";
    module2.exports = function(str2) {
      if (typeof str2 === "string" && str2.charAt(0) === "\uFEFF") {
        return str2.slice(1);
      }
      return str2;
    };
  }
});

// node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/utils.js
var require_utils = __commonJS({
  "node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/utils.js"(exports2) {
    "use strict";
    var stripBom = require_strip_bom_string();
    var typeOf = require_kind_of();
    exports2.define = function(obj, key, val) {
      Reflect.defineProperty(obj, key, {
        enumerable: false,
        configurable: true,
        writable: true,
        value: val
      });
    };
    exports2.isBuffer = function(val) {
      return typeOf(val) === "buffer";
    };
    exports2.isObject = function(val) {
      return typeOf(val) === "object";
    };
    exports2.toBuffer = function(input) {
      return typeof input === "string" ? Buffer.from(input) : input;
    };
    exports2.toString = function(input) {
      if (exports2.isBuffer(input)) return stripBom(String(input));
      if (typeof input !== "string") {
        throw new TypeError("expected input to be a string or buffer");
      }
      return stripBom(input);
    };
    exports2.arrayify = function(val) {
      return val ? Array.isArray(val) ? val : [val] : [];
    };
    exports2.startsWith = function(str2, substr, len) {
      if (typeof len !== "number") len = substr.length;
      return str2.slice(0, len) === substr;
    };
  }
});

// node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/defaults.js
var require_defaults = __commonJS({
  "node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/defaults.js"(exports2, module2) {
    "use strict";
    var engines2 = require_engines();
    var utils = require_utils();
    module2.exports = function(options2) {
      const opts = Object.assign({}, options2);
      opts.delimiters = utils.arrayify(opts.delims || opts.delimiters || "---");
      if (opts.delimiters.length === 1) {
        opts.delimiters.push(opts.delimiters[0]);
      }
      opts.language = (opts.language || opts.lang || "yaml").toLowerCase();
      opts.engines = Object.assign({}, engines2, opts.parsers, opts.engines);
      return opts;
    };
  }
});

// node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/engine.js
var require_engine = __commonJS({
  "node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/engine.js"(exports2, module2) {
    "use strict";
    module2.exports = function(name, options2) {
      let engine = options2.engines[name] || options2.engines[aliase(name)];
      if (typeof engine === "undefined") {
        throw new Error('gray-matter engine "' + name + '" is not registered');
      }
      if (typeof engine === "function") {
        engine = { parse: engine };
      }
      return engine;
    };
    function aliase(name) {
      switch (name.toLowerCase()) {
        case "js":
        case "javascript":
          return "javascript";
        case "coffee":
        case "coffeescript":
        case "cson":
          return "coffee";
        case "yaml":
        case "yml":
          return "yaml";
        default: {
          return name;
        }
      }
    }
  }
});

// node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/stringify.js
var require_stringify = __commonJS({
  "node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/stringify.js"(exports2, module2) {
    "use strict";
    var typeOf = require_kind_of();
    var getEngine = require_engine();
    var defaults = require_defaults();
    module2.exports = function(file, data, options2) {
      if (data == null && options2 == null) {
        switch (typeOf(file)) {
          case "object":
            data = file.data;
            options2 = {};
            break;
          case "string":
            return file;
          default: {
            throw new TypeError("expected file to be a string or object");
          }
        }
      }
      const str2 = file.content;
      const opts = defaults(options2);
      if (data == null) {
        if (!opts.data) return file;
        data = opts.data;
      }
      const language = file.language || opts.language;
      const engine = getEngine(language, opts);
      if (typeof engine.stringify !== "function") {
        throw new TypeError('expected "' + language + '.stringify" to be a function');
      }
      data = Object.assign({}, file.data, data);
      const open = opts.delimiters[0];
      const close = opts.delimiters[1];
      const matter3 = engine.stringify(data, options2).trim();
      let buf = "";
      if (matter3 !== "{}") {
        buf = newline(open) + newline(matter3) + newline(close);
      }
      if (typeof file.excerpt === "string" && file.excerpt !== "") {
        if (str2.indexOf(file.excerpt.trim()) === -1) {
          buf += newline(file.excerpt) + newline(close);
        }
      }
      return buf + newline(str2);
    };
    function newline(str2) {
      return str2.slice(-1) !== "\n" ? str2 + "\n" : str2;
    }
  }
});

// node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/excerpt.js
var require_excerpt = __commonJS({
  "node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/excerpt.js"(exports2, module2) {
    "use strict";
    var defaults = require_defaults();
    module2.exports = function(file, options2) {
      const opts = defaults(options2);
      if (file.data == null) {
        file.data = {};
      }
      if (typeof opts.excerpt === "function") {
        return opts.excerpt(file, opts);
      }
      const sep = file.data.excerpt_separator || opts.excerpt_separator;
      if (sep == null && (opts.excerpt === false || opts.excerpt == null)) {
        return file;
      }
      const delimiter = typeof opts.excerpt === "string" ? opts.excerpt : sep || opts.delimiters[0];
      const idx = file.content.indexOf(delimiter);
      if (idx !== -1) {
        file.excerpt = file.content.slice(0, idx);
      }
      return file;
    };
  }
});

// node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/to-file.js
var require_to_file = __commonJS({
  "node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/to-file.js"(exports2, module2) {
    "use strict";
    var typeOf = require_kind_of();
    var stringify2 = require_stringify();
    var utils = require_utils();
    module2.exports = function(file) {
      if (typeOf(file) !== "object") {
        file = { content: file };
      }
      if (typeOf(file.data) !== "object") {
        file.data = {};
      }
      if (file.contents && file.content == null) {
        file.content = file.contents;
      }
      utils.define(file, "orig", utils.toBuffer(file.content));
      utils.define(file, "language", file.language || "");
      utils.define(file, "matter", file.matter || "");
      utils.define(file, "stringify", function(data, options2) {
        if (options2 && options2.language) {
          file.language = options2.language;
        }
        return stringify2(file, data, options2);
      });
      file.content = utils.toString(file.content);
      file.isEmpty = false;
      file.excerpt = "";
      return file;
    };
  }
});

// node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/parse.js
var require_parse = __commonJS({
  "node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/lib/parse.js"(exports2, module2) {
    "use strict";
    var getEngine = require_engine();
    var defaults = require_defaults();
    module2.exports = function(language, str2, options2) {
      const opts = defaults(options2);
      const engine = getEngine(language, opts);
      if (typeof engine.parse !== "function") {
        throw new TypeError('expected "' + language + '.parse" to be a function');
      }
      return engine.parse(str2, opts);
    };
  }
});

// node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/index.js
var require_gray_matter = __commonJS({
  "node_modules/.pnpm/gray-matter@4.0.3/node_modules/gray-matter/index.js"(exports2, module2) {
    "use strict";
    var fs = require("fs");
    var sections = require_section_matter();
    var defaults = require_defaults();
    var stringify2 = require_stringify();
    var excerpt = require_excerpt();
    var engines2 = require_engines();
    var toFile = require_to_file();
    var parse17 = require_parse();
    var utils = require_utils();
    function matter3(input, options2) {
      if (input === "") {
        return { data: {}, content: input, excerpt: "", orig: input };
      }
      let file = toFile(input);
      const cached = matter3.cache[file.content];
      if (!options2) {
        if (cached) {
          file = Object.assign({}, cached);
          file.orig = cached.orig;
          return file;
        }
        matter3.cache[file.content] = file;
      }
      return parseMatter(file, options2);
    }
    function parseMatter(file, options2) {
      const opts = defaults(options2);
      const open = opts.delimiters[0];
      const close = "\n" + opts.delimiters[1];
      let str2 = file.content;
      if (opts.language) {
        file.language = opts.language;
      }
      const openLen = open.length;
      if (!utils.startsWith(str2, open, openLen)) {
        excerpt(file, opts);
        return file;
      }
      if (str2.charAt(openLen) === open.slice(-1)) {
        return file;
      }
      str2 = str2.slice(openLen);
      const len = str2.length;
      const language = matter3.language(str2, opts);
      if (language.name) {
        file.language = language.name;
        str2 = str2.slice(language.raw.length);
      }
      let closeIndex = str2.indexOf(close);
      if (closeIndex === -1) {
        closeIndex = len;
      }
      file.matter = str2.slice(0, closeIndex);
      const block = file.matter.replace(/^\s*#[^\n]+/gm, "").trim();
      if (block === "") {
        file.isEmpty = true;
        file.empty = file.content;
        file.data = {};
      } else {
        file.data = parse17(file.language, file.matter, opts);
      }
      if (closeIndex === len) {
        file.content = "";
      } else {
        file.content = str2.slice(closeIndex + close.length);
        if (file.content[0] === "\r") {
          file.content = file.content.slice(1);
        }
        if (file.content[0] === "\n") {
          file.content = file.content.slice(1);
        }
      }
      excerpt(file, opts);
      if (opts.sections === true || typeof opts.section === "function") {
        sections(file, opts.section);
      }
      return file;
    }
    matter3.engines = engines2;
    matter3.stringify = function(file, data, options2) {
      if (typeof file === "string") file = matter3(file, options2);
      return stringify2(file, data, options2);
    };
    matter3.read = function(filepath, options2) {
      const str2 = fs.readFileSync(filepath, "utf8");
      const file = matter3(str2, options2);
      file.path = filepath;
      return file;
    };
    matter3.test = function(str2, options2) {
      return utils.startsWith(str2, defaults(options2).delimiters[0]);
    };
    matter3.language = function(str2, options2) {
      const opts = defaults(options2);
      const open = opts.delimiters[0];
      if (matter3.test(str2)) {
        str2 = str2.slice(open.length);
      }
      const language = str2.slice(0, str2.search(/\r?\n/));
      return {
        raw: language,
        name: language ? language.trim() : ""
      };
    };
    matter3.cache = {};
    matter3.clearCache = function() {
      matter3.cache = {};
    };
    module2.exports = matter3;
  }
});

// lib/plugin/convert/cli-source.ts
var CLI_EXECUTE_PERMISSION = "cli:execute";
function assertBinaryName(binary) {
  const name = binary.trim();
  if (!name) throw new Error("--input is required for --from cli (the binary name, e.g. `rg`)");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      `"${binary}" is not a bare binary name \u2014 pass the name as it appears on PATH (e.g. \`rg\`), not a path or command line`
    );
  }
  return name;
}
function listCliCandidates(binary) {
  const name = assertBinaryName(binary);
  return [{ id: name, label: name, detail: "external binary resolved on PATH" }];
}
function buildCliSkeleton(binary) {
  const name = assertBinaryName(binary);
  return {
    binary: { name },
    cliTools: [],
    todos: [
      `cliTools is empty \u2014 add at least one tool definition, or \`cognia plugin lint\` will report manifest.capability.field_missing`,
      `set requires.binaries[0].minVersion and documentation so users get an actionable message when ${name} is missing`,
      `see README.md for the argv DSL and plugins/ripgrep-tools for a complete example`
    ]
  };
}

// lib/plugin/convert/identity.ts
var DEFAULT_VERSION = "0.1.0";
var DEFAULT_LICENSE = "MIT";
var DEFAULT_AUTHOR = "unknown";
function slugify(raw) {
  const slug = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  return slug;
}
function deriveId(stem, suffix) {
  const slug = slugify(stem);
  if (!slug) throw new Error(`cannot derive a plugin id from "${stem}" \u2014 pass --id`);
  if (slug === suffix || slug.endsWith(`-${suffix}`)) return slug;
  return `${slug}-${suffix}`;
}
function titleize(raw) {
  return slugify(raw).split("-").filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
function resolveIdentity(defaults, overrides = {}) {
  const pick = (override, fallback) => {
    const trimmed = override?.trim();
    return trimmed ? trimmed : fallback;
  };
  const id = pick(overrides.id, deriveId(defaults.stem, defaults.suffix));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error(
      `plugin id "${id}" is invalid \u2014 it must start with a letter or digit and contain only letters, digits, ".", "-", or "_"`
    );
  }
  const authorEmail = overrides.authorEmail?.trim();
  return {
    id,
    name: pick(overrides.name, defaults.name || titleize(defaults.stem)),
    description: pick(overrides.description, defaults.description),
    version: pick(overrides.version, DEFAULT_VERSION),
    author: pick(overrides.author, defaults.author?.trim() || DEFAULT_AUTHOR),
    authorEmail: authorEmail || void 0,
    license: pick(overrides.license, DEFAULT_LICENSE),
    minAppVersion: pick(overrides.minAppVersion, defaults.hostVersion)
  };
}

// lib/plugin/convert/manifest.ts
var CONVERTED_MAIN = "dist/index.js";
var SUPPORTED = {
  availability: "supported",
  entrypoint: CONVERTED_MAIN
};
function blocked(reason) {
  return { availability: "blocked", reason };
}
var BLOCK_REASONS = {
  "host-process": "Spawns a local host process; desktop only.",
  "host-filesystem": "Reads files from the plugin directory through the desktop filesystem bridge."
};
function deriveRuntimeCompatibility(need) {
  if (need === "portable") {
    return { browser: SUPPORTED, tauri: SUPPORTED, mobile: SUPPORTED };
  }
  const reason = BLOCK_REASONS[need];
  return { browser: blocked(reason), tauri: SUPPORTED, mobile: blocked(reason) };
}
function assembleManifest(assembly) {
  const { identity, capabilities, permissions, need, contributions } = assembly;
  const author = identity.authorEmail ? { name: identity.author, email: identity.authorEmail } : { name: identity.author };
  const manifest = {
    id: identity.id,
    name: identity.name,
    version: identity.version,
    description: identity.description,
    type: "frontend",
    capabilities,
    main: CONVERTED_MAIN,
    author,
    license: identity.license,
    minAppVersion: identity.minAppVersion,
    engines: { cognia: `>=${identity.minAppVersion}` },
    permissions: permissions ?? [],
    activationEvents: ["startup"],
    runtimeCompatibility: deriveRuntimeCompatibility(need),
    ...contributions
  };
  return manifest;
}
function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}
`;
}

// lib/claude/agents/shared.ts
function normalizeMcpEntry(raw, opts = {}) {
  if (!raw || typeof raw !== "object") return null;
  const cfg = { ...raw };
  const urlKey = opts.urlKey ?? "url";
  const explicitType = cfg.type ?? cfg.transport;
  let transport;
  if (opts.forceTransport) {
    transport = opts.forceTransport;
  } else if (explicitType === "stdio" || explicitType === "sse" || explicitType === "http") {
    transport = explicitType;
  } else if (explicitType === "streamable-http") {
    transport = "http";
  } else if (typeof cfg.httpUrl === "string") {
    transport = "http";
    cfg.url = cfg.httpUrl;
    delete cfg.httpUrl;
  } else if (typeof cfg[urlKey] === "string") {
    transport = "http";
    if (urlKey !== "url") {
      cfg.url = cfg[urlKey];
      delete cfg[urlKey];
    }
  } else if (typeof cfg.command === "string") {
    transport = "stdio";
  } else {
    return null;
  }
  delete cfg.type;
  delete cfg.transport;
  return { transport, config: cfg };
}
function denormalizeMcpEntry(transport, config, opts = {}) {
  const out = { ...config };
  const typeKey = opts.typeKey === void 0 ? "type" : opts.typeKey;
  if (transport === "stdio") {
    if (typeKey) out[typeKey] = "stdio";
  } else if (opts.geminiUrlSplit) {
    if (transport === "http" && typeof out.url === "string") {
      out.httpUrl = out.url;
      delete out.url;
    }
  } else {
    if (typeKey) out[typeKey] = transport;
    const urlKey = opts.urlKey ?? "url";
    if (urlKey !== "url" && typeof out.url === "string") {
      out[urlKey] = out.url;
      delete out.url;
    }
  }
  return out;
}
function dropInvalidDrafts(drafts) {
  return drafts.filter((d) => {
    if (!d.name?.trim()) return false;
    if (d.transport === "stdio" && typeof d.config.command !== "string") {
      return false;
    }
    if (d.transport !== "stdio" && typeof d.config.url !== "string") {
      return false;
    }
    return true;
  });
}

// lib/claude/agents/claude-code.ts
function asRoot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function entriesFromMap(map) {
  const out = [];
  for (const [name, value] of Object.entries(map)) {
    const norm = normalizeMcpEntry(value);
    if (!norm) continue;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return out;
}
function parse2(value) {
  const root = asRoot(value);
  if (!root) return [];
  const seen = /* @__PURE__ */ new Map();
  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const draft of entriesFromMap(root.mcpServers)) {
      seen.set(draft.name, draft);
    }
  }
  if (root.projects && typeof root.projects === "object") {
    for (const project15 of Object.values(root.projects)) {
      if (!project15 || typeof project15 !== "object") continue;
      const map = project15.mcpServers;
      if (!map || typeof map !== "object") continue;
      for (const draft of entriesFromMap(map)) {
        if (!seen.has(draft.name)) seen.set(draft.name, draft);
      }
    }
  }
  return dropInvalidDrafts(Array.from(seen.values()));
}
function project(existing, servers, managedNames) {
  const root = asRoot(existing) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const next = {};
  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value;
    }
  }
  for (const server of servers) {
    next[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      typeKey: "type"
    });
  }
  return { ...root, mcpServers: next };
}
var CLAUDE_CODE_AGENT = {
  id: "claude-code",
  displayName: "Claude Code",
  description: "~/.claude.json \u2014 root mcpServers + projects[].mcpServers",
  writable: true,
  format: "json",
  parse: parse2,
  project
};

// lib/claude/agents/claude-desktop.ts
function asRoot2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse3(value) {
  const root = asRoot2(value);
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return [];
  const out = [];
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    const norm = normalizeMcpEntry(raw, { forceTransport: "stdio" });
    if (!norm) continue;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return dropInvalidDrafts(out);
}
function project2(existing, servers, managedNames) {
  const root = asRoot2(existing) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const next = {};
  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value;
    }
  }
  for (const server of servers) {
    if (server.transport !== "stdio") {
      continue;
    }
    next[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      typeKey: null
    });
  }
  return { ...root, mcpServers: next };
}
var CLAUDE_DESKTOP_AGENT = {
  id: "claude-desktop",
  displayName: "Claude Desktop",
  description: "claude_desktop_config.json \u2014 stdio servers only",
  writable: true,
  format: "json",
  parse: parse3,
  project: project2
};

// lib/claude/agents/cline.ts
function asRoot3(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse4(value) {
  const root = asRoot3(value);
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return [];
  const out = [];
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    const norm = normalizeMcpEntry(raw);
    if (!norm) continue;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return dropInvalidDrafts(out);
}
function project3() {
  throw new Error(
    "cline is read-only \u2014 globalStorage path is not stable enough for Cognia to safely write"
  );
}
var CLINE_AGENT = {
  id: "cline",
  displayName: "Cline",
  description: "VS Code extension \u2014 read-only (path varies)",
  writable: false,
  format: "json",
  parse: parse4,
  project: project3
};

// lib/claude/agents/codex.ts
function asRoot4(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function pickServerMap(root) {
  const a = root.mcp_servers;
  if (a && typeof a === "object") return a;
  const b = root["mcp.servers"];
  if (b && typeof b === "object") return b;
  return {};
}
function parse5(value) {
  const root = asRoot4(value);
  if (!root) return [];
  const map = pickServerMap(root);
  const out = [];
  for (const [name, raw] of Object.entries(map)) {
    const norm = normalizeMcpEntry(raw);
    if (!norm) continue;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return dropInvalidDrafts(out);
}
function project4(existing, servers, managedNames) {
  const root = asRoot4(existing) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const merged = { ...pickServerMap(root) };
  delete root["mcp.servers"];
  for (const name of managedSet) delete merged[name];
  for (const server of servers) {
    if (server.transport === "sse") {
      continue;
    }
    merged[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      typeKey: null
    });
  }
  return { ...root, mcp_servers: merged };
}
var CODEX_AGENT = {
  id: "codex",
  displayName: "Codex CLI",
  description: "~/.codex/config.toml \u2014 TOML, [mcp_servers.NAME] tables",
  writable: true,
  format: "toml",
  parse: parse5,
  project: project4
};

// lib/claude/agents/cognia.ts
function asRoot5(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse6(value) {
  const root = asRoot5(value);
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return [];
  const out = [];
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    const norm = normalizeMcpEntry(raw);
    if (!norm) continue;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return dropInvalidDrafts(out);
}
function project5(existing, servers, managedNames) {
  const root = asRoot5(existing) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const next = {};
  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value;
    }
  }
  for (const server of servers) {
    next[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      typeKey: "type"
    });
  }
  return { ...root, mcpServers: next };
}
var COGNIA_AGENT = {
  id: "cognia",
  displayName: "Cognia CLI",
  description: "~/.cognia/mcp.json \u2014 the standalone cognia-agent CLI",
  writable: true,
  format: "json",
  parse: parse6,
  project: project5
};

// lib/claude/agents/cursor.ts
function asRoot6(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse7(value) {
  const root = asRoot6(value);
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return [];
  const out = [];
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    const norm = normalizeMcpEntry(raw);
    if (!norm) continue;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return dropInvalidDrafts(out);
}
function project6(existing, servers, managedNames) {
  const root = asRoot6(existing) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const next = {};
  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value;
    }
  }
  for (const server of servers) {
    next[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      typeKey: "type"
    });
  }
  return { ...root, mcpServers: next };
}
var CURSOR_AGENT = {
  id: "cursor",
  displayName: "Cursor",
  description: "~/.cursor/mcp.json \u2014 global Cursor MCP config",
  writable: true,
  format: "json",
  parse: parse7,
  project: project6
};

// lib/claude/agents/gemini.ts
function asRoot7(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse8(value) {
  const root = asRoot7(value);
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return [];
  const out = [];
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    if (!raw || typeof raw !== "object") continue;
    const cfg = raw;
    if (typeof cfg.command === "string") {
      const norm = normalizeMcpEntry(cfg, { forceTransport: "stdio" });
      if (norm) out.push({ name, transport: norm.transport, config: norm.config });
    } else if (typeof cfg.url === "string") {
      const norm = normalizeMcpEntry(cfg, { forceTransport: "sse" });
      if (norm) out.push({ name, transport: norm.transport, config: norm.config });
    } else if (typeof cfg.httpUrl === "string") {
      const canonical = { ...cfg, url: cfg.httpUrl };
      delete canonical.httpUrl;
      const norm = normalizeMcpEntry(canonical, { forceTransport: "http" });
      if (norm) out.push({ name, transport: norm.transport, config: norm.config });
    }
  }
  return dropInvalidDrafts(out);
}
function emit(server) {
  const cfg = { ...server.config };
  if (server.transport === "stdio") {
    return cfg;
  }
  if (server.transport === "sse") {
    return cfg;
  }
  if (typeof cfg.url === "string") {
    cfg.httpUrl = cfg.url;
    delete cfg.url;
  }
  return cfg;
}
function project7(existing, servers, managedNames) {
  const root = asRoot7(existing) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const next = {};
  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value;
    }
  }
  for (const server of servers) {
    next[server.name] = emit(server);
  }
  return { ...root, mcpServers: next };
}
var GEMINI_AGENT = {
  id: "gemini",
  displayName: "Gemini CLI",
  description: "~/.gemini/settings.json \u2014 url=SSE, httpUrl=HTTP",
  writable: true,
  format: "json",
  parse: parse8,
  project: project7
};

// lib/claude/agents/kiro.ts
var KIRO_ONLY_KEYS = ["disabled", "autoApprove", "disabledTools"];
function asRoot8(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse9(value) {
  const root = asRoot8(value);
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return [];
  const out = [];
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = { ...raw };
    for (const key of KIRO_ONLY_KEYS) delete entry[key];
    const norm = normalizeMcpEntry(entry);
    if (!norm) continue;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return dropInvalidDrafts(out);
}
function project8(existing, servers, managedNames) {
  const root = asRoot8(existing) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const next = {};
  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value;
    }
  }
  for (const server of servers) {
    const prior = root.mcpServers?.[server.name];
    const carried = {};
    if (prior && typeof prior === "object") {
      for (const key of KIRO_ONLY_KEYS) {
        const value = prior[key];
        if (value !== void 0) carried[key] = value;
      }
    }
    next[server.name] = {
      ...denormalizeMcpEntry(server.transport, server.config, { typeKey: null }),
      ...carried
    };
  }
  return { ...root, mcpServers: next };
}
var KIRO_AGENT = {
  id: "kiro",
  displayName: "Kiro",
  description: "~/.kiro/settings/mcp.json \u2014 no `type` key, local vs remote inferred",
  writable: true,
  format: "json",
  parse: parse9,
  project: project8
};

// lib/claude/agents/opencode.ts
function asRoot9(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse10(value) {
  const root = asRoot9(value);
  if (!root?.mcp || typeof root.mcp !== "object") return [];
  const out = [];
  for (const [name, raw] of Object.entries(root.mcp)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw;
    if (entry.type === "remote" || typeof entry.url === "string") {
      if (typeof entry.url !== "string") continue;
      const config2 = { url: entry.url };
      if (entry.headers && typeof entry.headers === "object") config2.headers = entry.headers;
      out.push({ name, transport: "http", config: config2 });
      continue;
    }
    const command = entry.command;
    if (!Array.isArray(command) || command.length === 0) continue;
    const [bin, ...args] = command.filter((c) => typeof c === "string");
    if (!bin) continue;
    const config = { command: bin };
    if (args.length > 0) config.args = args;
    if (entry.environment && typeof entry.environment === "object") {
      config.env = entry.environment;
    }
    out.push({ name, transport: "stdio", config });
  }
  return dropInvalidDrafts(out);
}
function project9(existing, servers, managedNames) {
  const root = asRoot9(existing) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const next = {};
  if (root.mcp && typeof root.mcp === "object") {
    for (const [name, value] of Object.entries(root.mcp)) {
      if (!managedSet.has(name)) next[name] = value;
    }
  }
  for (const server of servers) {
    const config = server.config;
    const enabled = server.enabled !== false;
    if (server.transport === "stdio") {
      const bin = typeof config.command === "string" ? config.command : "";
      const args = Array.isArray(config.args) ? config.args.filter((a) => typeof a === "string") : [];
      const entry2 = {
        type: "local",
        command: [bin, ...args],
        enabled
      };
      const env = config.env;
      if (env && typeof env === "object" && Object.keys(env).length > 0) {
        entry2.environment = env;
      }
      next[server.name] = entry2;
      continue;
    }
    const entry = {
      type: "remote",
      url: typeof config.url === "string" ? config.url : "",
      enabled
    };
    const headers = config.headers;
    if (headers && typeof headers === "object" && Object.keys(headers).length > 0) {
      entry.headers = headers;
    }
    next[server.name] = entry;
  }
  return { ...root, mcp: next };
}
var OPENCODE_AGENT = {
  id: "opencode",
  displayName: "opencode",
  description: "~/.config/opencode/opencode.json \u2014 `mcp` key, command is one array",
  writable: true,
  format: "json",
  parse: parse10,
  project: project9
};

// lib/claude/agents/pi-mcp-adapter.ts
var SERVERS_KEY = "mcpServers";
var SERVERS_KEY_ALT = "mcp-servers";
function asRoot10(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function serversKeyOf(root) {
  if (root && root[SERVERS_KEY] === void 0 && root[SERVERS_KEY_ALT] !== void 0) {
    return SERVERS_KEY_ALT;
  }
  return SERVERS_KEY;
}
function serversOf(root) {
  if (!root) return null;
  const raw = root[serversKeyOf(root)];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw;
}
function parse11(value) {
  const servers = serversOf(asRoot10(value));
  if (!servers) return [];
  const out = [];
  for (const [name, raw] of Object.entries(servers)) {
    const norm = normalizeMcpEntry(raw);
    if (!norm) continue;
    if (norm.config.httpTransport === "sse") norm.transport = "sse";
    else if (norm.config.httpTransport === "streamable-http") norm.transport = "http";
    delete norm.config.httpTransport;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return dropInvalidDrafts(out);
}
function project10(existing, servers, managedNames) {
  const root = asRoot10(existing) ?? {};
  const key = serversKeyOf(asRoot10(existing));
  const current = serversOf(asRoot10(existing)) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const next = {};
  for (const [name, value] of Object.entries(current)) {
    if (!managedSet.has(name)) next[name] = value;
  }
  for (const server of servers) {
    const entry = denormalizeMcpEntry(server.transport, server.config, { typeKey: null });
    if (server.transport === "sse") entry.httpTransport = "sse";
    next[server.name] = entry;
  }
  return { ...root, [key]: next };
}
var PI_MCP_ADAPTER_AGENT = {
  id: "pi-mcp-adapter",
  displayName: "Pi (MCP adapter)",
  description: "~/.pi/agent/mcp.json \u2014 requires the pi-mcp-adapter package",
  writable: true,
  format: "json",
  parse: parse11,
  project: project10
};

// lib/claude/agents/roo-code.ts
function asRoot11(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse12(value) {
  const root = asRoot11(value);
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return [];
  const out = [];
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    const norm = normalizeMcpEntry(raw);
    if (!norm) continue;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return dropInvalidDrafts(out);
}
function project11() {
  throw new Error(
    "roo-code is read-only \u2014 globalStorage path is not stable enough for Cognia to safely write"
  );
}
var ROO_CODE_AGENT = {
  id: "roo-code",
  displayName: "Roo Code",
  description: "VS Code extension \u2014 read-only (path varies)",
  writable: false,
  format: "json",
  parse: parse12,
  project: project11
};

// lib/claude/agents/vscode.ts
function asRoot12(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse13(value) {
  const root = asRoot12(value);
  if (!root?.servers || typeof root.servers !== "object") return [];
  const out = [];
  for (const [name, raw] of Object.entries(root.servers)) {
    const norm = normalizeMcpEntry(raw);
    if (!norm) continue;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return dropInvalidDrafts(out);
}
function project12(existing, servers, managedNames) {
  const root = asRoot12(existing) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const next = {};
  if (root.servers && typeof root.servers === "object") {
    for (const [name, value] of Object.entries(root.servers)) {
      if (!managedSet.has(name)) next[name] = value;
    }
  }
  for (const server of servers) {
    next[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      typeKey: "type"
    });
  }
  return { ...root, servers: next };
}
var VSCODE_AGENT = {
  id: "vscode",
  displayName: "VS Code (Copilot)",
  description: "User mcp.json \u2014 top-level key `servers`, JSONC",
  writable: true,
  format: "jsonc",
  parse: parse13,
  project: project12
};

// lib/claude/agents/windsurf.ts
function asRoot13(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse14(value) {
  const root = asRoot13(value);
  if (!root?.mcpServers || typeof root.mcpServers !== "object") return [];
  const out = [];
  for (const [name, raw] of Object.entries(root.mcpServers)) {
    const norm = normalizeMcpEntry(raw, { urlKey: "serverUrl" });
    if (!norm) continue;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return dropInvalidDrafts(out);
}
function project13(existing, servers, managedNames) {
  const root = asRoot13(existing) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const next = {};
  if (root.mcpServers && typeof root.mcpServers === "object") {
    for (const [name, value] of Object.entries(root.mcpServers)) {
      if (!managedSet.has(name)) next[name] = value;
    }
  }
  for (const server of servers) {
    next[server.name] = denormalizeMcpEntry(server.transport, server.config, {
      // Windsurf doesn't use a `type` discriminator at all; transport is
      // inferred from `command` vs `serverUrl`.
      typeKey: null,
      urlKey: "serverUrl"
    });
  }
  return { ...root, mcpServers: next };
}
var WINDSURF_AGENT = {
  id: "windsurf",
  displayName: "Windsurf",
  description: "~/.codeium/windsurf/mcp_config.json \u2014 uses `serverUrl`",
  writable: true,
  format: "json",
  parse: parse14,
  project: project13
};

// lib/claude/agents/zed.ts
var ZED_ONLY_KEYS = ["enabled", "remote"];
function asRoot14(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function isExtensionEntry(entry) {
  return "settings" in entry && !("command" in entry) && !("url" in entry);
}
function parse15(value) {
  const root = asRoot14(value);
  if (!root?.context_servers || typeof root.context_servers !== "object") return [];
  const out = [];
  for (const [name, raw] of Object.entries(root.context_servers)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = { ...raw };
    if (isExtensionEntry(entry)) continue;
    for (const key of ZED_ONLY_KEYS) delete entry[key];
    const norm = normalizeMcpEntry(entry);
    if (!norm) continue;
    out.push({ name, transport: norm.transport, config: norm.config });
  }
  return dropInvalidDrafts(out);
}
function project14(existing, servers, managedNames) {
  const root = asRoot14(existing) ?? {};
  const managedSet = managedNames ?? new Set(servers.map((s) => s.name));
  const next = {};
  if (root.context_servers && typeof root.context_servers === "object") {
    for (const [name, value] of Object.entries(root.context_servers)) {
      const isExtension = !!value && typeof value === "object" && isExtensionEntry(value);
      if (!managedSet.has(name) || isExtension) next[name] = value;
    }
  }
  for (const server of servers) {
    if (next[server.name] !== void 0) continue;
    next[server.name] = {
      // Zed has a first-class `enabled` flag, so honour the server's own
      // toggle instead of projecting a disabled server as live.
      enabled: server.enabled !== false,
      ...denormalizeMcpEntry(server.transport, server.config, { typeKey: null })
    };
  }
  return { ...root, context_servers: next };
}
var ZED_AGENT = {
  id: "zed",
  displayName: "Zed",
  description: "settings.json `context_servers` \u2014 no `type` key, JSONC",
  writable: true,
  format: "jsonc",
  parse: parse15,
  project: project14
};

// lib/claude/agents/index.ts
var MCP_AGENT_ADAPTERS = [
  COGNIA_AGENT,
  CLAUDE_CODE_AGENT,
  CLAUDE_DESKTOP_AGENT,
  CURSOR_AGENT,
  VSCODE_AGENT,
  CODEX_AGENT,
  GEMINI_AGENT,
  WINDSURF_AGENT,
  ZED_AGENT,
  KIRO_AGENT,
  OPENCODE_AGENT,
  // Last of the writable adapters: unlike the rest, its file is only read when
  // a third-party Pi package is installed, so surfaces that offer a sync target
  // gate it on detection rather than listing it unconditionally.
  PI_MCP_ADAPTER_AGENT,
  CLINE_AGENT,
  ROO_CODE_AGENT
];
var ADAPTERS_BY_ID = new Map(MCP_AGENT_ADAPTERS.map((a) => [a.id, a]));

// node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/date.js
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    if (typeof date === "string") {
      let match = date.match(DATE_TIME_RE);
      if (match) {
        if (!match[1]) {
          hasDate = false;
          date = `0000-01-01T${date}`;
        }
        hasTime = !!match[2];
        hasTime && date[10] === " " && (date = date.replace(" ", "T"));
        if (match[2] && +match[2] > 23) {
          date = "";
        } else {
          offset = match[3] || null;
          date = date.toUpperCase();
          if (!offset && hasTime)
            date += "Z";
        }
      } else {
        date = "";
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r\n|\n|\r/g);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class extends Error {
  line;
  column;
  codeblock;
  constructor(message, options2) {
    const [line, column] = getLineColFromPtr(options2.toml, options2.ptr);
    const codeblock = makeCodeBlock(options2.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options2);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
};

// node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/util.js
function indexOfNewline(str2, start = 0) {
  let idx = str2.indexOf("\n", start);
  if (str2.charCodeAt(idx - 1) === 13)
    idx--;
  return idx;
}
function skipComment(ctx) {
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      throw new TomlError("control characters are not allowed in comments", {
        toml: ctx.s,
        ptr: ctx.p
      });
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (1) {
    while ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}
function skipUntil(ctx, sep, end) {
  let ptr = ctx.p;
  if (!end) {
    ptr = indexOfNewline(ctx.s, ptr);
    ctx.p = ptr < 0 ? ctx.s.length : ptr;
    return;
  }
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 35) {
      skipComment(ctx);
    } else if (c === end || c === sep) {
      return;
    }
  }
  throw new TomlError("cannot find end of structure", {
    toml: ctx.s,
    ptr
  });
}

// node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/primitive.js
var INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
var FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
var LEADING_ZERO = /^[+-]?0[0-9_]/;
function parseString(ctx) {
  let start = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (; ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      throw new TomlError("control characters are not allowed in strings", {
        toml: ctx.s,
        ptr: ctx.p
      });
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state)
        parsed += ctx.s.slice(sliceStart, ctx.p);
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0; j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p + 1);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            throw new TomlError("invalid non-hex character in unicode escape", { toml: ctx.s, ptr: ctx.p + 1 });
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          throw new TomlError("invalid unicode escape", { toml: ctx.s, ptr: ctx.p });
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p + 1;
        state = 0;
      } else if (c === 32 || c === 9) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "	";
        else if (c === 110)
          parsed += "\n";
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          throw new TomlError("unrecognized escape sequence", { toml: ctx.s, ptr: ctx.p });
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2) {
        throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
          toml: ctx.s,
          ptr: sliceStart
        });
      }
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  throw new TomlError("unfinished string", { toml: ctx.s, ptr: start });
}
function sliceAndTrimEndOf(ctx, start, end) {
  let value = ctx.s.slice(start, end);
  let commentIdx = value.indexOf("#");
  if (commentIdx > 0) {
    skipComment({ s: value, p: commentIdx, d: 0 });
    value = value.slice(0, commentIdx);
  }
  return value.trimEnd();
}
function parseValue(ctx, integersAsBigInt, end) {
  let ptr = ctx.p;
  let err = { toml: ctx.s, ptr };
  skipUntil(ctx, 44, end);
  let value = sliceAndTrimEndOf(ctx, ptr, ctx.p);
  if (!value)
    throw new TomlError("incomplete declaration: value expected", err);
  if (value === "-inf")
    return -Infinity;
  if (value === "inf" || value === "+inf")
    return Infinity;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value)) {
      throw new TomlError("leading zeroes are not allowed", err);
    }
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric)) {
      throw new TomlError("invalid number", err);
    }
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
        throw new TomlError("integer value cannot be represented losslessly", err);
      }
      if (isInt || integersAsBigInt === true)
        numeric = BigInt(value);
    }
    return numeric;
  }
  const date = new TomlDate(value);
  if (!date.isValid())
    throw new TomlError("invalid value", err);
  return date;
}

// node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/extract.js
function extractValue(ctx, end, integersAsBigInt) {
  let ptr = ctx.p;
  let c = ctx.s.charCodeAt(ptr);
  if (c === 91 || c === 123) {
    if (!ctx.d--) {
      throw new TomlError("document contains excessively nested structures. aborting.", {
        toml: ctx.s,
        ptr
      });
    }
    let value = c === 91 ? parseArray(ctx, integersAsBigInt) : parseInlineTable(ctx, integersAsBigInt);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      throw new TomlError("invalid value", { toml: ctx.s, ptr });
    ctx.p++;
    return true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      throw new TomlError("invalid value", { toml: ctx.s, ptr });
    ctx.p++;
    return false;
  }
  return parseValue(ctx, integersAsBigInt, end);
}

// node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/struct.js
var KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
function parseKey(ctx, end = "=") {
  let start = ctx.p;
  let dot = start - 1;
  let parsed = [];
  let endPtr = ctx.s.indexOf(end, start);
  if (endPtr < 0) {
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: ctx.s,
      ptr: start
    });
  }
  do {
    let c = ctx.s.charCodeAt(ctx.p = ++dot);
    if (c !== 32 && c !== 9) {
      if (c === 34 || c === 39) {
        if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2)) {
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        let part = parseString(ctx);
        dot = ctx.s.indexOf(".", ctx.p);
        let strEnd = ctx.s.slice(ctx.p, dot < 0 || dot > endPtr ? endPtr : dot);
        let newLine = indexOfNewline(strEnd);
        if (newLine > -1) {
          throw new TomlError("newlines are not allowed in keys", {
            toml: ctx.s,
            ptr: newLine
          });
        }
        if (strEnd.trimStart()) {
          throw new TomlError("found extra tokens after the string part", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        if (endPtr < ctx.p) {
          endPtr = ctx.s.indexOf(end, ctx.p);
          if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: ctx.s,
              ptr: start
            });
          }
        }
        parsed.push(part);
      } else {
        dot = ctx.s.indexOf(".", ctx.p);
        let part = ctx.s.slice(ctx.p, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part)) {
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        parsed.push(part.trimEnd());
      }
    }
  } while (dot + 1 && dot < endPtr);
  ctx.p = endPtr + 1;
  skipVoid(ctx, true, true);
  return parsed;
}
function parseInlineTable(ctx, integersAsBigInt) {
  let res = {};
  let seen = /* @__PURE__ */ new Set();
  let c;
  ctx.p++;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let p = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0; i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = {};
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        throw new TomlError("trying to redefine an already defined value", {
          toml: ctx.s,
          ptr: p
        });
      }
      if (!hasOwn && k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      throw new TomlError("trying to redefine an already defined value", {
        toml: ctx.s,
        ptr: ctx.p
      });
    }
    let value = extractValue(ctx, 125, integersAsBigInt);
    seen.add(t[k] = value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44) {
      throw new TomlError("expected comma or end of structure", { toml: ctx.s, ptr: ctx.p - 1 });
    }
  }
  throw new TomlError("unfinished table encountered", {
    toml: ctx.s,
    ptr: ctx.p
  });
}
function parseArray(ctx, integersAsBigInt) {
  let res = [];
  let c;
  ctx.p++;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(ctx, 93, integersAsBigInt));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44) {
      throw new TomlError("expected comma or end of structure", { toml: ctx.s, ptr: ctx.p - 1 });
    }
  }
  throw new TomlError("unfinished array encountered", {
    toml: ctx.s,
    ptr: ctx.p
  });
}

// node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/parse.js
function peekTable(key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = {};
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      if (k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = {});
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: {} };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = {};
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function parse16(toml, { maxDepth = 1e3, integersAsBigInt } = {}) {
  let ctx = { s: toml, p: 0, d: maxDepth };
  let res = {};
  let meta = {};
  let tmp;
  let tbl = res;
  let m = meta;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      let k = parseKey(ctx, "]");
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p - 1) !== 93) {
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: ctx.p - 1
          });
        }
        ctx.p++;
      }
      let p = peekTable(
        k,
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr: tmp
        });
      }
      m = p[2];
      tbl = p[1];
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(
        k,
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr: tmp
        });
      }
      p[1][p[0]] = extractValue(ctx, void 0, integersAsBigInt);
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && tmp !== 13) {
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr: ctx.p
      });
    }
    skipVoid(ctx);
  }
  return res;
}

// node_modules/.pnpm/smol-toml@1.8.0/node_modules/smol-toml/dist/stringify.js
var BARE_KEY = /^[a-z0-9-_]+$/i;
function extendedTypeOf(obj) {
  let type = typeof obj;
  if (type === "object") {
    if (Array.isArray(obj))
      return "array";
    if (typeof obj?.getUTCDate === "function" && obj instanceof Date)
      return "date";
    if (globalThis.Temporal && // check for the 'since' property as an early bailout that avoids running all 5 instanceof checks
    typeof obj?.since === "function" && (obj instanceof Temporal.Instant || obj instanceof Temporal.PlainDate || obj instanceof Temporal.PlainDateTime || obj instanceof Temporal.PlainTime || obj instanceof Temporal.ZonedDateTime)) {
      return "temporal";
    }
  }
  return type;
}
function isArrayOfTables(obj) {
  for (let i = 0; i < obj.length; i++) {
    if (extendedTypeOf(obj[i]) !== "object")
      return false;
  }
  return obj.length != 0;
}
function formatString(s) {
  return JSON.stringify(s).replace(/\x7f/g, "\\u007f");
}
function stringifyTemporal(temporal) {
  return temporal.toString({
    calendarName: "never",
    timeZoneName: "never"
  });
}
function stringifyValue(val, type, depth, numberAsFloat) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  switch (type) {
    // @ts-expect-error -- intentional fallthrough case
    case "number":
      if (isNaN(val))
        return "nan";
      if (val === Infinity)
        return "inf";
      if (val === -Infinity)
        return "-inf";
      if (Number.isInteger(val) && (numberAsFloat || !Number.isSafeInteger(val)))
        return val.toFixed(1);
    case "bigint":
    case "boolean":
      return val.toString();
    case "string":
      return formatString(val);
    case "date":
      if (isNaN(val.getTime()))
        throw new TypeError("cannot serialize invalid date");
      return val.toISOString();
    case "object":
      return stringifyInlineTable(val, depth, numberAsFloat);
    case "array":
      return stringifyArray(val, depth, numberAsFloat);
    case "temporal":
      return stringifyTemporal(val);
  }
}
function stringifyInlineTable(obj, depth, numberAsFloat) {
  let keys = Object.keys(obj);
  if (keys.length === 0)
    return "{}";
  let res = "{ ";
  for (let i = 0; i < keys.length; i++) {
    let k = keys[i];
    if (i)
      res += ", ";
    res += BARE_KEY.test(k) ? k : formatString(k);
    res += " = ";
    res += stringifyValue(obj[k], extendedTypeOf(obj[k]), depth - 1, numberAsFloat);
  }
  return res + " }";
}
function stringifyArray(array, depth, numberAsFloat) {
  if (array.length === 0)
    return "[]";
  let res = "[ ";
  for (let i = 0; i < array.length; i++) {
    if (i)
      res += ", ";
    if (array[i] === null || array[i] === void 0) {
      throw new TypeError("arrays cannot contain null or undefined values");
    }
    res += stringifyValue(array[i], extendedTypeOf(array[i]), depth - 1, numberAsFloat);
  }
  return res + " ]";
}
function stringifyArrayTable(array, key, depth, numberAsFloat) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  let res = "";
  for (let i = 0; i < array.length; i++) {
    res += `${res && "\n"}[[${key}]]
`;
    res += stringifyTable(0, array[i], key, depth, numberAsFloat);
  }
  return res;
}
function stringifyTable(tableKey, obj, prefix, depth, numberAsFloat) {
  if (depth === 0) {
    throw new Error("Could not stringify the object: maximum object depth exceeded");
  }
  let preamble = "";
  let tables = "";
  let keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    let k = keys[i];
    if (obj[k] !== null && obj[k] !== void 0) {
      let type = extendedTypeOf(obj[k]);
      if (type === "symbol" || type === "function") {
        throw new TypeError(`cannot serialize values of type '${type}'`);
      }
      let key = BARE_KEY.test(k) ? k : formatString(k);
      if (type === "array" && isArrayOfTables(obj[k])) {
        tables += (tables && "\n") + stringifyArrayTable(obj[k], prefix ? `${prefix}.${key}` : key, depth - 1, numberAsFloat);
      } else if (type === "object") {
        let tblKey = prefix ? `${prefix}.${key}` : key;
        tables += (tables && "\n") + stringifyTable(tblKey, obj[k], tblKey, depth - 1, numberAsFloat);
      } else {
        preamble += key;
        preamble += " = ";
        preamble += stringifyValue(obj[k], type, depth, numberAsFloat);
        preamble += "\n";
      }
    }
  }
  if (tableKey && (preamble || !tables))
    preamble = preamble ? `[${tableKey}]
${preamble}` : `[${tableKey}]`;
  return preamble && tables ? `${preamble}
${tables}` : preamble || tables;
}
function stringify(obj, { maxDepth = 1e3, numbersAsFloat = false } = {}) {
  if (extendedTypeOf(obj) !== "object") {
    throw new TypeError("stringify can only be called with an object");
  }
  let str2 = stringifyTable(0, obj, "", maxDepth, numbersAsFloat);
  if (str2[str2.length - 1] !== "\n")
    return str2 + "\n";
  return str2;
}

// lib/plugin/convert/secrets.ts
var SECRET_MARKERS = [
  "key",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "auth",
  "session",
  "cookie",
  "signature",
  "private",
  "dsn",
  "webhook"
];
function looksSecret(name) {
  const lower = name.toLowerCase();
  return SECRET_MARKERS.some((marker) => lower.includes(marker));
}
function humanizeKey(key) {
  const words = key.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function isAbsolutePathArg(value) {
  if (value.startsWith("~/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return /^\/[^/]/.test(value);
}
function urlCarriesCredential(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.username || url.password) return true;
  for (const name of url.searchParams.keys()) {
    if (looksSecret(name)) return true;
  }
  return false;
}
function tokenKeyForPath(value, taken) {
  const segment = value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "path";
  const base = segment.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "PATH";
  let key = base;
  let n = 2;
  while (taken.has(key)) {
    key = `${base}_${n}`;
    n += 1;
  }
  taken.add(key);
  return key;
}
function sanitizeMcpConfig(transport, config) {
  const next = JSON.parse(JSON.stringify(config));
  const fields = [];
  const todos = [];
  const takenTokens = /* @__PURE__ */ new Set();
  const env = next.env;
  if (env && typeof env === "object" && !Array.isArray(env)) {
    const blanked = {};
    for (const key of Object.keys(env)) {
      const secret = looksSecret(key);
      blanked[key] = "";
      fields.push({
        key,
        label: humanizeKey(key),
        placement: "env",
        ...secret ? { secret: true } : {}
      });
      todos.push(
        secret ? `env ${key} is a credential \u2014 its value was NOT copied; users supply it when they add the server` : `env ${key} was blanked \u2014 set a safe default in plugin.json if one exists`
      );
    }
    if (Object.keys(blanked).length > 0) {
      next.env = blanked;
    } else {
      delete next.env;
    }
  }
  const args = next.args;
  if (Array.isArray(args)) {
    next.args = args.map((arg) => {
      if (typeof arg !== "string" || !isAbsolutePathArg(arg)) return arg;
      const key = tokenKeyForPath(arg, takenTokens);
      const token = `<${key}>`;
      fields.push({
        key,
        label: humanizeKey(key),
        placement: "arg-replace",
        token,
        description: "Path on this machine; the original value was not copied."
      });
      todos.push(`argument ${token} is a machine-specific path users must supply`);
      return token;
    });
  }
  const headers = next.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const key of Object.keys(headers)) {
      fields.push({
        key,
        label: humanizeKey(key),
        placement: "header",
        secret: true
      });
      todos.push(`header ${key} is user-specific \u2014 its value was NOT copied`);
    }
    delete next.headers;
  }
  if (transport !== "stdio" && typeof next.url === "string" && urlCarriesCredential(next.url)) {
    delete next.url;
    fields.push({
      key: "url",
      label: "Server URL",
      placement: "url",
      description: "The original URL carried a credential and was not copied."
    });
    todos.push("the server URL carried a credential \u2014 users supply the full URL");
  }
  return { config: next, fields, todos };
}

// lib/plugin/convert/mcp-source.ts
var SUPPORTED_MCP_ADAPTERS = MCP_AGENT_ADAPTERS;
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}
function selectMcpAdapter(sourceName, value) {
  const lower = (sourceName ?? "").toLowerCase();
  const byName = SUPPORTED_MCP_ADAPTERS.find((adapter) => lower.includes(adapter.id));
  if (byName && byName.parse(value).length > 0) return byName;
  const productive = SUPPORTED_MCP_ADAPTERS.find((adapter) => adapter.parse(value).length > 0);
  if (productive) return productive;
  throw new Error(
    "no MCP servers found in this file \u2014 expected a config with an `mcpServers` (or `servers`) object"
  );
}
function readMcpDrafts(text, sourceName) {
  let value;
  const toml = /\.toml$/i.test(sourceName ?? "");
  if (toml) {
    try {
      value = parse16(text);
    } catch (err) {
      throw new Error(
        `could not parse "${sourceName ?? "input"}" as TOML: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    try {
      value = JSON.parse(stripJsonComments(text));
    } catch (err) {
      throw new Error(
        `could not parse "${sourceName ?? "input"}" as JSON/JSONC: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const adapter = selectMcpAdapter(sourceName, value);
  return { adapter, drafts: adapter.parse(value) };
}
function listMcpCandidates(text, sourceName) {
  const { drafts } = readMcpDrafts(text, sourceName);
  return drafts.map((draft) => ({
    id: draft.name,
    label: draft.name,
    detail: draft.transport === "stdio" ? `stdio \xB7 ${String(draft.config.command ?? "")}` : `${draft.transport} \xB7 ${String(draft.config.url ?? "")}`
  }));
}
function buildMcpPreset(text, pick, sourceName) {
  const { drafts } = readMcpDrafts(text, sourceName);
  const draft = drafts.find((d) => d.name === pick);
  if (!draft) {
    const available = drafts.map((d) => d.name).join(", ") || "(none)";
    throw new Error(`no MCP server named "${pick}" in this file \u2014 available: ${available}`);
  }
  const { config, fields, todos } = sanitizeMcpConfig(draft.transport, draft.config);
  const preset = {
    id: draft.name,
    name: draft.name,
    // Built from the SANITIZED config, never the source one: the raw
    // invocation embeds the very absolute paths and URLs that sanitization
    // just replaced, and the description is copied into plugin.json,
    // package.json, and README.md.
    description: describeConfig(draft.transport, config),
    transport: draft.transport,
    config,
    fields
  };
  return { preset, draft, todos };
}
function describeConfig(transport, config) {
  if (transport === "stdio") {
    const command = String(config.command ?? "").trim();
    const args = Array.isArray(config.args) ? config.args.filter((a) => typeof a === "string") : [];
    const invocation = [command, ...args].filter(Boolean).join(" ");
    return `MCP server run locally via \`${invocation}\`.`;
  }
  const url = String(config.url ?? "").trim();
  return url ? `Remote ${transport.toUpperCase()} MCP server at ${url}.` : `Remote ${transport.toUpperCase()} MCP server.`;
}

// lib/plugin/convert/merge.ts
function parseExistingManifest(text, path) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const manifest = parsed;
  if (typeof manifest.id !== "string" || !manifest.id) {
    throw new Error(`${path} is missing a string \`id\``);
  }
  return manifest;
}
function mergeContribution(existing, request) {
  const warnings = [];
  const manifest = JSON.parse(JSON.stringify(existing));
  const record = manifest;
  const capabilities = Array.isArray(manifest.capabilities) ? [...manifest.capabilities] : [];
  if (!capabilities.includes(request.capability)) {
    capabilities.push(request.capability);
  }
  manifest.capabilities = capabilities;
  const current = record[request.manifestField];
  if (current !== void 0 && !Array.isArray(current)) {
    throw new Error(
      `existing manifest field "${request.manifestField}" is not an array \u2014 refusing to overwrite it`
    );
  }
  const entries = Array.isArray(current) ? [...current] : [];
  if (entries.some((e) => e && typeof e === "object" && e.id === request.entry.id)) {
    throw new Error(
      `"${request.manifestField}" already contains an entry with id "${request.entry.id}" \u2014 pass --id to give the imported one a different id, or remove the existing entry first`
    );
  }
  entries.push(request.entry);
  record[request.manifestField] = entries;
  if (request.permissions?.length) {
    const permissions = Array.isArray(manifest.permissions) ? [...manifest.permissions] : [];
    for (const permission of request.permissions) {
      if (!permissions.includes(permission)) {
        permissions.push(permission);
        warnings.push(`added required permission "${permission}"`);
      }
    }
    manifest.permissions = permissions;
  }
  if (request.need !== "portable") {
    const required = deriveRuntimeCompatibility(request.need);
    for (const target of ["browser", "mobile"]) {
      const declared = manifest.runtimeCompatibility?.[target]?.availability;
      if (declared && declared !== "blocked") {
        warnings.push(
          `runtimeCompatibility.${target} is "${declared}", but the imported contribution cannot run there \u2014 set it to "blocked" with reason: ${required[target]?.reason ?? ""}`
        );
      }
    }
  }
  return { manifest, warnings };
}

// lib/plugin/convert/scaffold.ts
var DEV_DEPENDENCIES = {
  "@cognia/plugin-sdk": "^0.1.0",
  "@types/node": "^22.0.0",
  esbuild: "^0.24.0",
  typescript: "^5.6.0"
};
var ESBUILD_ARGS = "src/index.ts --bundle --format=cjs --platform=neutral --target=es2022 --outfile=dist/index.js --log-level=info";
function renderEntry(manifest, kind) {
  const dispatch = {
    mcp: "`mcpServerPresets` in plugin.json is registered by the host's overlay dispatch",
    skill: "`skills` in plugin.json is registered by the host's overlay dispatch",
    cli: "`cliTools` in plugin.json is materialised by the plugin manager"
  };
  return `/**
 * ${manifest.name} \u2014 generated by \`cognia plugin import\`.
 *
 * This entry is intentionally almost empty: ${dispatch[kind]},
 * so no imperative registration is needed here. The manifest is imported
 * rather than restated so plugin.json stays the single source of truth.
 *
 * Add your own logic inside \`activate\` when you need behaviour the
 * manifest cannot express.
 */

import type { PluginContext, PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
import manifest from "../plugin.json"

const definition: PluginDefinition = {
  manifest: manifest as unknown as PluginManifest,

  activate: async (ctx: PluginContext) => {
    ctx.logger.info("${manifest.id} activated")
  },

  deactivate: async (ctx?: PluginContext) => {
    ctx?.logger.info("${manifest.id} deactivated")
  },
}

export default definition
`;
}
function renderDist(manifest) {
  return `"use strict";
// Built output of src/index.ts, pre-generated by \`cognia plugin import\`.
// Re-run \`pnpm build\` after editing src/index.ts, and commit the result:
// the in-app GitHub installer performs a build-free install.
const manifest = ${JSON.stringify(manifest, null, 2)};

const definition = {
  manifest,
  activate: async (ctx) => {
    ctx.logger.info("${manifest.id} activated");
  },
  deactivate: async (ctx) => {
    ctx?.logger.info("${manifest.id} deactivated");
  },
};

module.exports = { __esModule: true, default: definition };
`;
}
function renderPackageJson(manifest) {
  const pkg = {
    name: manifest.id,
    version: manifest.version,
    private: true,
    description: manifest.description,
    scripts: {
      build: `esbuild ${ESBUILD_ARGS}`,
      typecheck: "tsc --noEmit"
    },
    devDependencies: DEV_DEPENDENCIES
  };
  return `${JSON.stringify(pkg, null, 2)}
`;
}
function renderTsconfig() {
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      isolatedModules: true,
      strict: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      declaration: false,
      outDir: "dist",
      lib: ["ES2022", "DOM"],
      types: ["node"]
    },
    include: ["src/**/*.ts", "plugin.json"],
    exclude: ["node_modules", "dist"]
  };
  return `${JSON.stringify(tsconfig, null, 2)}
`;
}
function renderGitignore() {
  return ["node_modules/", "coverage/", ".cognia/", "*.log", ""].join("\n");
}
function renderReadme(manifest, kind, todos) {
  const todoSection = todos.length > 0 ? `
## Before this plugin works

${todos.map((t) => `- ${t}`).join("\n")}
` : "";
  return `# ${manifest.name}

${manifest.description}

Generated by \`cognia plugin import --from ${kind}\`. Nothing was executed to
produce it: the source artifact was read as text, and no value from it was
copied into \`plugin.json\`.
${todoSection}
## Layout

\`\`\`
${manifest.id}/
\u251C\u2500\u2500 plugin.json       \u2014 the manifest; the ONLY place contributions are declared
\u251C\u2500\u2500 src/index.ts      \u2014 empty shell; imports plugin.json, registers nothing
\u251C\u2500\u2500 dist/index.js     \u2014 build output; committed so GitHub installs work
\u251C\u2500\u2500 package.json
\u251C\u2500\u2500 tsconfig.json
\u2514\u2500\u2500 README.md
\`\`\`

## Workflow

\`\`\`bash
pnpm install           # once, to get esbuild + the SDK types
pnpm build             # esbuild \u2192 dist/index.js
cognia plugin lint     # validate plugin.json against the host schema
cognia plugin install .   # into a running cognia desktop
\`\`\`

\`dist/index.js\` is committed on purpose. The in-app GitHub installer
performs a build-free install, so a repository without it clones into an
uninstallable plugin. Re-run \`pnpm build\` and commit the result whenever
you change \`src/index.ts\`.

${SOURCE_NOTES[kind]}
`;
}
var SOURCE_NOTES = {
  mcp: `## Editing the preset

\`mcpServerPresets[0]\` is what users see in Settings \u2192 MCP Servers \u2192 Add
server. \`fields[]\` declares what they must fill in; \`config\` holds only
non-user-specific defaults. Every credential from the source config was
turned into a field with no value \u2014 fill nothing in here, that is the point.

- \`placement: "env"\` \u2014 written into \`config.env[key]\`
- \`placement: "arg-replace"\` \u2014 replaces \`token\` inside \`config.args\`
- \`placement: "header"\` \u2014 written into \`config.headers[key]\`
- \`placement: "url"\` \u2014 replaces \`config.url\`
- \`secret: true\` \u2014 rendered as a password input

Set \`icon\`, \`docsUrl\`, and \`tags\` to make the gallery card readable.`,
  skill: `## Editing the skill

\`skills[0]\` is registered into the skill picker when the plugin is
enabled. An \`inline\` source carries the SKILL.md body in the manifest and
works in every shell (desktop, browser, mobile). A \`local-bundle\` source
points at a folder inside this plugin and is desktop-only, because the
resources are read through the desktop filesystem bridge.

Set \`scope\` to \`"character"\`, \`"team"\`, or \`"global"\` to control which
picker it appears in.`,
  cli: `## Filling in the tool table

\`cliTools\` is empty: a binary's \`--help\` does not state which flags take
values, which repeat, what the exit codes mean, or which output format the
agent should receive, and this converter does not run anything to find out.
Guessing would produce a tool that lints green and misbehaves.

Each entry needs a JSON Schema for its parameters plus an \`argv\` token
list. Parameters substitute as exactly one argv element each, which is what
makes the wrapper injection-safe \u2014 never concatenate values into a string.

\`\`\`jsonc
{
  "name": "ripgrep_search",
  "description": "Search file contents. Exit code 1 (no matches) is success.",
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string", "description": "Regular expression" },
      "globs": { "type": "array", "items": { "type": "string" } },
      "ignoreCase": { "type": "boolean" }
    },
    "required": ["pattern"]
  },
  "binary": { "kind": "requires", "name": "rg" },
  "argv": [
    { "literal": "--json" },
    { "param": "ignoreCase", "eachPrefixedBy": "-i", "omitWhenEmpty": true },
    { "param": "globs", "eachPrefixedBy": "--glob", "omitWhenEmpty": true },
    { "param": "pattern", "eachPrefixedBy": "-e" },
    { "literal": "--" },
    { "param": "path", "omitWhenEmpty": true }
  ],
  "cwd": { "kind": "workspace" },
  "outputParse": "lines",
  "successExitCodes": [0, 1],
  "timeoutMs": 60000,
  "maxOutputBytes": 500000
}
\`\`\`

\`plugins/ripgrep-tools/plugin.json\` in the cognia repository is the
reference implementation. Until \`cliTools\` has at least one entry,
\`cognia plugin lint\` reports \`manifest.capability.field_missing\`.`
};
function renderProject(manifest, kind, todos) {
  return /* @__PURE__ */ new Map([
    ["plugin.json", serializeManifest(manifest)],
    ["src/index.ts", renderEntry(manifest, kind)],
    ["dist/index.js", renderDist(manifest)],
    ["package.json", renderPackageJson(manifest)],
    ["tsconfig.json", renderTsconfig()],
    [".gitignore", renderGitignore()],
    ["README.md", renderReadme(manifest, kind, todos)]
  ]);
}

// lib/claude/skills-io.ts
var import_gray_matter = __toESM(require_gray_matter());

// lib/skills/slug.ts
var MAX_SKILL_SLUG_LENGTH = 64;
var SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function isValidSkillSlug(value) {
  return Boolean(value && value.length <= MAX_SKILL_SLUG_LENGTH && SKILL_SLUG_PATTERN.test(value));
}
function normalizeSkillSlug(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SKILL_SLUG_LENGTH).replace(/-+$/g, "");
}
function nativeBasename(path) {
  const normalized = path?.replace(/\\/g, "/").replace(/\/+$/g, "");
  return normalized?.split("/").pop();
}
function deriveSkillSlug(skill) {
  if (isValidSkillSlug(skill.slug)) return skill.slug;
  const native = nativeBasename(skill.nativeDirectory);
  if (isValidSkillSlug(native)) return native;
  if (isValidSkillSlug(skill.name)) return skill.name;
  const normalized = normalizeSkillSlug(skill.name);
  if (normalized) return normalized;
  const suffix = normalizeSkillSlug(skill.id.replace(/^skill[_-]?/i, "")).slice(-12) || "local";
  return `skill-${suffix}`.slice(0, MAX_SKILL_SLUG_LENGTH);
}

// lib/claude/skills-io.ts
var VALID_CATEGORIES = [
  "creative-design",
  "development",
  "enterprise",
  "productivity",
  "data-analysis",
  "communication",
  "meta",
  "custom"
];
var KNOWN_FRONTMATTER_KEYS = /* @__PURE__ */ new Set([
  "name",
  "description",
  "compatibility",
  "metadata",
  "allowed-tools",
  "allowedTools",
  "tags",
  "category",
  "version",
  "author",
  "license",
  "disable-model-invocation",
  "allow_implicit_invocation"
]);
var KNOWN_BUT_UNMODELLED_KEYS = /* @__PURE__ */ new Set([
  "priority",
  "sessionStart",
  "pathPatterns",
  "bashPatterns",
  "importPatterns",
  "promptSignals"
]);
function serializeSkill(skill) {
  const slug = deriveSkillSlug({ id: "skill-export", name: skill.name, slug: skill.slug });
  const data = { ...skill.frontmatterExtensions ?? {}, name: slug };
  if (skill.description?.trim()) data.description = skill.description.trim();
  if (skill.compatibility?.trim()) data.compatibility = skill.compatibility.trim();
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    data["allowed-tools"] = skill.allowedTools.join(" ");
  }
  const extensionMetadata = skill.frontmatterExtensions?.metadata;
  const metadata = {
    ...extensionMetadata && typeof extensionMetadata === "object" && !Array.isArray(extensionMetadata) ? extensionMetadata : {},
    ...skill.metadata ?? {}
  };
  metadata["cognia.display-name"] = skill.name;
  if (skill.author?.trim()) metadata.author = skill.author.trim();
  if (skill.version?.trim()) metadata.version = skill.version.trim();
  if (skill.category && skill.category !== "custom") metadata["cognia.category"] = skill.category;
  if (skill.tags && skill.tags.length > 0) metadata["cognia.tags"] = JSON.stringify(skill.tags);
  if (skill.invocationPolicy) metadata["cognia.invocation-policy"] = skill.invocationPolicy;
  if (Object.keys(metadata).length > 0) data.metadata = metadata;
  if (skill.invocationPolicy === "explicit") data["disable-model-invocation"] = true;
  if (skill.license?.trim()) data.license = skill.license.trim();
  const body = skill.content.endsWith("\n") ? skill.content : `${skill.content}
`;
  return import_gray_matter.default.stringify(body, data);
}
function parseSkillMarkdown(text, opts = {}) {
  const warnings = [];
  const portabilityIssues = [];
  let parsed;
  try {
    parsed = (0, import_gray_matter.default)(text);
  } catch (err) {
    throw new Error(
      `Failed to parse frontmatter: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const fm = parsed.data ?? {};
  const body = parsed.content.trim();
  let portableName = stringOrUndef(fm.name);
  if (!portableName) {
    portableName = opts.fallbackName?.trim() || "";
    if (portableName) warnings.push(`No 'name' in frontmatter \u2014 using "${portableName}".`);
  }
  if (!portableName) {
    throw new Error("Skill is missing a name (no frontmatter and no fallback).");
  }
  if (!body) {
    throw new Error(`Skill "${portableName}" has no content body.`);
  }
  const description = stringOrUndef(fm.description);
  const compatibility = stringOrUndef(fm.compatibility);
  const allowedTools = parseToolList(fm["allowed-tools"]) ?? parseToolList(fm.allowedTools);
  const tags = parseList(fm.tags);
  const categoryRaw = stringOrUndef(fm.category)?.toLowerCase();
  const category = VALID_CATEGORIES.includes(categoryRaw ?? "") ? categoryRaw : void 0;
  if (categoryRaw && !category) {
    warnings.push(`Unknown category "${categoryRaw}" \u2014 falling back to "custom".`);
  }
  const version = stringOrUndef(fm.version);
  const author = stringOrUndef(fm.author);
  const license = stringOrUndef(fm.license);
  const metadata = parseStringMetadata(fm.metadata, warnings);
  const metadataTags = parseJsonStringArray(metadata?.["cognia.tags"]);
  const metadataCategory = metadata?.["cognia.category"];
  const resolvedCategory = VALID_CATEGORIES.includes(metadataCategory ?? "") ? metadataCategory : category;
  const invocationMetadata = metadata?.["cognia.invocation-policy"];
  const explicitByVendor = fm["disable-model-invocation"] === true || fm.allow_implicit_invocation === false;
  const invocationPolicy = explicitByVendor || invocationMetadata === "explicit" ? "explicit" : invocationMetadata === "implicit" ? "implicit" : void 0;
  const displayName = metadata?.["cognia.display-name"]?.trim() || portableName;
  const slug = deriveSkillSlug({ id: `skill-${portableName}`, name: portableName });
  if (!isValidSkillSlug(portableName)) {
    portabilityIssues.push({
      code: "slug-format",
      field: "slug",
      severity: "portability",
      message: `Imported frontmatter name "${portableName}" was normalized to slug "${slug}".`
    });
  }
  const frontmatterExtensions = Object.fromEntries(
    Object.entries(fm).filter(
      ([key, value]) => !KNOWN_FRONTMATTER_KEYS.has(key) || key === "metadata" && (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(
        (entry) => typeof entry !== "string"
      ))
    )
  );
  for (const key of Object.keys(fm)) {
    if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
    if (KNOWN_BUT_UNMODELLED_KEYS.has(key)) {
      warnings.push(
        `Frontmatter key "${key}" is recognised by Claude Code's dynamic-activation model and is preserved without Cognia runtime behavior.`
      );
      continue;
    }
    warnings.push(`Unknown frontmatter key "${key}" \u2014 preserved.`);
  }
  return {
    draft: {
      name: displayName,
      slug,
      description,
      compatibility,
      metadata,
      content: body,
      allowedTools,
      tags: tags ?? metadataTags,
      category: resolvedCategory,
      version: version ?? metadata?.version,
      author: author ?? metadata?.author,
      license,
      invocationPolicy,
      frontmatterExtensions: Object.keys(frontmatterExtensions).length > 0 ? frontmatterExtensions : void 0
    },
    warnings,
    portabilityIssues
  };
}
function stringOrUndef(v) {
  if (typeof v !== "string") return void 0;
  const trimmed = v.trim();
  return trimmed ? trimmed : void 0;
}
function parseList(v) {
  if (Array.isArray(v)) {
    const arr = v.map((x) => typeof x === "string" ? x.trim() : "").filter(Boolean);
    return arr.length > 0 ? arr : void 0;
  }
  if (typeof v === "string") {
    const arr = v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    return arr.length > 0 ? arr : void 0;
  }
  return void 0;
}
function parseToolList(v) {
  if (Array.isArray(v)) return parseList(v);
  if (typeof v !== "string") return void 0;
  const values = v.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : void 0;
}
function parseStringMetadata(value, warnings) {
  if (value === void 0) return void 0;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("Frontmatter metadata must be a string-to-string mapping.");
    return void 0;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
    else warnings.push(`Frontmatter metadata key "${key}" was not a string and was ignored.`);
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
function parseJsonStringArray(value) {
  if (!value) return void 0;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : void 0;
  } catch {
    return void 0;
  }
}

// lib/plugin/convert/skill-source.ts
var BUNDLE_RESOURCE_DIRS = ["scripts", "references", "assets"];
var SKILL_BUNDLE_DIR = "skills";
function listSkillCandidates(text, sourceName) {
  const { draft } = parseSkillMarkdown(text, { fallbackName: sourceName });
  return [
    {
      id: slugify(draft.name),
      label: draft.name,
      detail: draft.description ?? "SKILL.md"
    }
  ];
}
function isBundleResource(relativePath) {
  const head = relativePath.replace(/^[./\\]+/, "").split(/[\\/]/)[0];
  return BUNDLE_RESOURCE_DIRS.includes(head);
}
function buildSkill(text, resources = [], sourceName) {
  const { draft, warnings } = parseSkillMarkdown(text, { fallbackName: sourceName });
  const id = slugify(draft.name);
  if (!id) throw new Error(`cannot derive a skill id from name "${draft.name}"`);
  const bundled = resources.filter(isBundleResource);
  const ignored = resources.filter((r) => !isBundleResource(r) && !/^SKILL\.md$/i.test(r));
  const allWarnings = [...warnings];
  for (const path of ignored) {
    allWarnings.push(
      `"${path}" is not under ${BUNDLE_RESOURCE_DIRS.join("/")} and was not copied into the plugin`
    );
  }
  if (bundled.length === 0) {
    return {
      skill: {
        id,
        name: draft.name,
        description: draft.description ?? "",
        source: { kind: "inline", markdown: draft.content },
        ...draft.allowedTools?.length ? { allowedTools: [...draft.allowedTools] } : {}
      },
      needsFilesystem: false,
      copies: [],
      warnings: allWarnings
    };
  }
  const bundleDir = `${SKILL_BUNDLE_DIR}/${id}`;
  return {
    skill: {
      id,
      name: draft.name,
      description: draft.description ?? "",
      source: { kind: "local-bundle", path: bundleDir },
      ...draft.allowedTools?.length ? { allowedTools: [...draft.allowedTools] } : {}
    },
    needsFilesystem: true,
    copies: [
      { from: "SKILL.md", to: `${bundleDir}/SKILL.md` },
      ...bundled.map((path) => ({ from: path, to: `${bundleDir}/${path}` }))
    ],
    warnings: allWarnings
  };
}

// lib/plugin/convert/index.ts
var FALLBACK_HOST_VERSION = "0.1.0";
var ID_SUFFIX = {
  mcp: "mcp",
  skill: "skill",
  cli: "tools"
};
function listCandidates(input) {
  switch (input.kind) {
    case "mcp":
      return listMcpCandidates(requireText(input), input.sourceName);
    case "skill":
      return listSkillCandidates(requireText(input), input.sourceName);
    case "cli":
      return listCliCandidates(input.binary ?? "");
  }
}
function requireText(input) {
  if (typeof input.text !== "string") {
    throw new Error(`--from ${input.kind} needs the source file's contents`);
  }
  return input.text;
}
function buildContribution(input) {
  switch (input.kind) {
    case "mcp": {
      const pick = requirePick(input, "MCP server");
      const { preset, draft, todos } = buildMcpPreset(requireText(input), pick, input.sourceName);
      return {
        capability: "mcp-server-preset",
        manifestField: "mcpServerPresets",
        entry: preset,
        permissions: [],
        need: draft.transport === "stdio" ? "host-process" : "portable",
        extraFields: {},
        identityDefaults: {
          stem: preset.id,
          name: preset.name,
          description: preset.description ?? ""
        },
        todos,
        warnings: [],
        copies: []
      };
    }
    case "skill": {
      const built = buildSkill(requireText(input), input.resources ?? [], input.sourceName);
      return {
        capability: "skills",
        manifestField: "skills",
        entry: built.skill,
        permissions: [],
        need: built.needsFilesystem ? "host-filesystem" : "portable",
        extraFields: {},
        identityDefaults: {
          stem: built.skill.id,
          name: built.skill.name,
          description: built.skill.description
        },
        todos: [],
        warnings: built.warnings,
        copies: built.copies
      };
    }
    case "cli": {
      const built = buildCliSkeleton(input.binary ?? "");
      return {
        capability: "cli-tools",
        manifestField: "cliTools",
        // The skeleton contributes no entries; `entry` is only consumed by
        // the merge path, which refuses an empty contribution below.
        entry: { id: built.binary.name },
        permissions: [CLI_EXECUTE_PERMISSION],
        need: "host-process",
        extraFields: { requires: { binaries: [built.binary] } },
        identityDefaults: {
          stem: built.binary.name,
          name: built.binary.name,
          description: `Declarative agent tools wrapping the \`${built.binary.name}\` CLI.`
        },
        todos: built.todos,
        warnings: [],
        copies: []
      };
    }
  }
}
function requirePick(input, what) {
  const pick = input.pick?.trim();
  if (!pick) {
    throw new Error(`--pick is required: this input holds more than one ${what}`);
  }
  return pick;
}
function convert(input, options2 = {}) {
  const contribution = buildContribution(input);
  if (options2.existingManifestText !== void 0) {
    if (input.kind === "cli") {
      throw new Error(
        "--into is not supported for --from cli: the skeleton contributes no cliTools entries, so there is nothing to merge. Add the capability to your plugin by hand."
      );
    }
    const path = options2.existingManifestPath ?? "plugin.json";
    const existing = parseExistingManifest(options2.existingManifestText, path);
    const renamed = input.identity?.id?.trim();
    const entry = renamed ? { ...contribution.entry, id: renamed } : contribution.entry;
    const { manifest: manifest2, warnings } = mergeContribution(existing, {
      capability: contribution.capability,
      manifestField: contribution.manifestField,
      entry,
      permissions: contribution.permissions,
      need: contribution.need
    });
    return {
      mode: "merge",
      pluginId: manifest2.id,
      manifest: manifest2,
      files: /* @__PURE__ */ new Map([["plugin.json", `${JSON.stringify(manifest2, null, 2)}
`]]),
      copies: contribution.copies,
      todos: contribution.todos,
      warnings: [...contribution.warnings, ...warnings]
    };
  }
  const identity = resolveIdentity(
    {
      ...contribution.identityDefaults,
      suffix: ID_SUFFIX[input.kind],
      hostVersion: options2.hostVersion ?? FALLBACK_HOST_VERSION,
      author: options2.gitAuthor
    },
    input.identity
  );
  const contributions = {
    ...contribution.extraFields,
    [contribution.manifestField]: input.kind === "cli" ? [] : [contribution.entry]
  };
  const manifest = assembleManifest({
    identity,
    capabilities: [contribution.capability],
    permissions: contribution.permissions,
    need: contribution.need,
    contributions
  });
  return {
    mode: "create",
    pluginId: manifest.id,
    manifest,
    files: renderProject(manifest, input.kind, contribution.todos),
    copies: contribution.copies,
    todos: contribution.todos,
    warnings: contribution.warnings
  };
}

// lib/claude/agents/markdown-agents.ts
var import_gray_matter2 = __toESM(require_gray_matter());
function serializeMarkdownAgent(id, def) {
  const data = {
    name: id,
    description: def.description
  };
  if (def.model) data.model = def.model;
  if (def.effort) data.effort = def.effort;
  if (def.maxTurns) data.maxTurns = def.maxTurns;
  if (def.tools?.length) data.tools = [...def.tools];
  if (def.disallowedTools?.length) data.disallowedTools = [...def.disallowedTools];
  const body = def.prompt.endsWith("\n") ? def.prompt : `${def.prompt}
`;
  return import_gray_matter2.default.stringify(body, data);
}
function normalizeToolList(value) {
  if (Array.isArray(value)) {
    const arr = value.map((v) => String(v).trim()).filter(Boolean);
    return arr.length ? arr : void 0;
  }
  if (typeof value === "string") {
    const arr = value.split(",").map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : void 0;
  }
  return void 0;
}
function parseMarkdownAgent(id, content) {
  let data;
  let body;
  try {
    const parsed = (0, import_gray_matter2.default)(content);
    data = parsed.data ?? {};
    body = parsed.content ?? "";
  } catch (err) {
    return {
      id,
      error: `frontmatter parse failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  const prompt = body.trim();
  if (!prompt) return { id, error: "empty body (no system prompt)" };
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!description) return { id, error: "missing `description` frontmatter" };
  const def = { description, prompt };
  if (typeof data.model === "string" && data.model.trim()) def.model = data.model.trim();
  if (typeof data.provider === "string" && data.provider.trim()) {
    def.provider = data.provider.trim();
  }
  const tools = normalizeToolList(data.tools ?? data["allowed-tools"]);
  if (tools) def.tools = tools;
  const disallowed = normalizeToolList(data.disallowedTools ?? data["disallowed-tools"]);
  if (disallowed) def.disallowedTools = disallowed;
  const maxTurns = data.maxTurns ?? data["max-turns"];
  if (typeof maxTurns === "number" && Number.isInteger(maxTurns) && maxTurns > 0) {
    def.maxTurns = maxTurns;
  } else if (typeof maxTurns === "string" && /^\d+$/.test(maxTurns.trim()) && Number(maxTurns) > 0) {
    def.maxTurns = Number(maxTurns);
  }
  const effort = data.effort;
  if (effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh" || effort === "max") {
    def.effort = effort;
  }
  const externalPreset = data.externalPresetId ?? data["external-preset-id"];
  if (typeof externalPreset === "string" && externalPreset.trim()) {
    def.externalPresetId = externalPreset.trim();
  }
  const mcpServerIds = normalizeToolList(data.mcpServerIds ?? data["mcp-server-ids"]);
  if (mcpServerIds) def.mcpServerIds = mcpServerIds;
  const allowNesting = data.allowNesting ?? data["allow-nesting"];
  if (allowNesting === true || allowNesting === "true") def.allowNesting = true;
  const maxDepth = data.maxDepth ?? data["max-depth"];
  if (typeof maxDepth === "number" && Number.isFinite(maxDepth)) {
    def.maxDepth = maxDepth;
  } else if (typeof maxDepth === "string" && maxDepth.trim() && !Number.isNaN(Number(maxDepth))) {
    def.maxDepth = Number(maxDepth);
  }
  const hidden = data.hidden;
  if (hidden === true || hidden === "true") def.hidden = true;
  const disabled = data.disabled ?? data.disable;
  if (disabled === true || disabled === "true") def.disabled = true;
  const unsupportedFields = [
    "skills",
    "memory",
    "background",
    "isolation",
    "hooks",
    "mcpServers",
    "permissionMode"
  ].filter((key) => {
    const value = data[key];
    if (value === void 0 || value === null || value === false) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
  const declaredName = typeof data.name === "string" ? data.name.trim() : "";
  return { id: declaredName || id, def, unsupportedFields };
}

// lib/plugin/convert/ecosystem.ts
var UnsupportedPluginConversionError = class extends Error {
  constructor(source, target, report) {
    const details = report.blocking.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    super(`cannot convert ${source} plugin to ${target} without losing behavior: ${details}`);
    this.name = "UnsupportedPluginConversionError";
    this.report = report;
  }
};
function normalizePath(path) {
  const parts = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error(`path escapes plugin root: ${path}`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}
function parseJsonObject(text, path) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value;
}
function requiredString(value, path) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}
function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function stringArray(value) {
  if (!Array.isArray(value)) return void 0;
  const result = value.filter((item) => typeof item === "string");
  return result.length > 0 ? result : void 0;
}
function configured(value) {
  if (value === void 0 || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}
function pathList(value, defaultPath) {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === "string") : defaultPath ? [defaultPath] : [];
  return raw.map(normalizePath);
}
function filesBelow(files, directory) {
  const prefix = `${normalizePath(directory)}/`;
  return Array.from(files.keys()).map(normalizePath).filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
}
function displayNameFromPath(path) {
  const basename2 = normalizePath(path).split("/").pop() ?? path;
  return basename2.replace(/\.(md|json)$/i, "");
}
function authorFields(author, fallbackName = "unknown") {
  if (typeof author === "string" && author.trim()) return { name: author.trim() };
  if (author && typeof author === "object" && !Array.isArray(author)) {
    const record = author;
    const name = optionalString(record.name) ?? fallbackName;
    const email = optionalString(record.email);
    const url = optionalString(record.url);
    return {
      name,
      ...email ? { email } : {},
      ...url ? { url } : {}
    };
  }
  return { name: fallbackName };
}
function replacePluginRootToken(value) {
  if (typeof value === "string") {
    return value.replaceAll("${CLAUDE_PLUGIN_ROOT}", "${COGNIA_PLUGIN_ROOT}").replaceAll("${CODEX_PLUGIN_ROOT}", "${COGNIA_PLUGIN_ROOT}").replaceAll("${extensionPath}", "${COGNIA_PLUGIN_ROOT}");
  }
  if (Array.isArray(value)) return value.map(replacePluginRootToken);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replacePluginRootToken(item)])
    );
  }
  return value;
}
var UNSUPPORTED_RUNTIME_TOKENS = [
  "${CLAUDE_PLUGIN_DATA}",
  "${CLAUDE_PROJECT_DIR}",
  "${workspacePath}"
];
function rejectUnsupportedRuntimeTokens(args) {
  const found = UNSUPPORTED_RUNTIME_TOKENS.filter((token) => args.text.includes(token));
  if (found.length === 0) return false;
  args.report.blocking.push({
    capability: args.capability,
    path: args.path,
    message: `runtime variables have no equivalent Cognia binding: ${found.join(", ")}`,
    blocking: true
  });
  return true;
}
function unsupportedIssue(capability) {
  return {
    capability,
    path: capability,
    message: `${capability} has no behaviorally equivalent Cognia declarative contribution`,
    blocking: true
  };
}
function reportUnknownManifestFields(args) {
  for (const field of Object.keys(args.manifest).sort()) {
    if (args.known.has(field)) continue;
    args.report.blocking.push({
      capability: field,
      path: `${args.sourcePath}.${field}`,
      message: "unknown manifest field may carry behavior and cannot be converted safely",
      blocking: true
    });
  }
}
function reportUnmappedPresentationFields(value, mapped, report) {
  if (!value) return;
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!configured(fieldValue) || mapped.has(field)) continue;
    report.warnings.push({
      capability: "interface",
      path: `interface.${field}`,
      message: "presentation metadata has no Cognia manifest equivalent and was not projected",
      blocking: false
    });
  }
}
function cloneFiles(files) {
  return new Map(Array.from(files, ([path, contents]) => [normalizePath(path), contents]));
}
function metadataFromForeignManifest(manifest, sourcePath, interfaceMetadata) {
  const rawName = requiredString(manifest.name, `${sourcePath}.name`);
  const id = slugify(rawName);
  if (!id) throw new Error(`${sourcePath}.name cannot produce a valid plugin id`);
  return {
    id,
    name: optionalString(manifest.displayName) ?? optionalString(interfaceMetadata?.displayName) ?? rawName,
    version: optionalString(manifest.version) ?? "0.1.0",
    description: optionalString(manifest.description) ?? optionalString(interfaceMetadata?.shortDescription) ?? "",
    author: authorFields(manifest.author),
    license: optionalString(manifest.license) ?? "MIT",
    homepage: optionalString(manifest.homepage) ?? optionalString(interfaceMetadata?.websiteURL),
    repository: optionalString(manifest.repository),
    keywords: stringArray(manifest.keywords),
    icon: optionalString(interfaceMetadata?.logo) ?? optionalString(interfaceMetadata?.composerIcon),
    screenshots: stringArray(interfaceMetadata?.screenshots)
  };
}
function finalizeForeignConversion(args) {
  const { source, output: output2, metadata, contributions, report, options: options2 } = args;
  if (report.blocking.length > 0) {
    report.fidelity = "unsupported";
    throw new UnsupportedPluginConversionError(source, "cognia", report);
  }
  const capabilities = [];
  if (contributions.skills.length > 0) capabilities.push("skills");
  if (contributions.subagents.length > 0) capabilities.push("subagent");
  if (contributions.presets.length > 0) capabilities.push("mcp-server-preset");
  const need = contributions.presets.some((preset) => preset.transport === "stdio") ? "host-process" : contributions.needsFilesystem ? "host-filesystem" : "portable";
  const manifest = assembleManifest({
    identity: {
      id: metadata.id,
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      author: metadata.author.name,
      authorEmail: metadata.author.email,
      license: metadata.license,
      minAppVersion: options2.hostVersion ?? "0.1.0"
    },
    capabilities,
    need,
    contributions: {
      ...contributions.skills.length > 0 ? { skills: contributions.skills } : {},
      ...contributions.subagents.length > 0 ? { subagents: contributions.subagents } : {},
      ...contributions.presets.length > 0 ? { mcpServerPresets: contributions.presets } : {}
    }
  });
  manifest.homepage = metadata.homepage;
  manifest.repository = metadata.repository;
  manifest.keywords = metadata.keywords;
  manifest.icon = metadata.icon;
  manifest.screenshots = metadata.screenshots;
  if (metadata.author.url && manifest.author) {
    manifest.author.url = metadata.author.url;
  }
  output2.set("plugin.json", serializeManifest(manifest));
  output2.set("dist/index.js", renderDist(manifest));
  return {
    source,
    target: "cognia",
    manifest,
    files: output2,
    copies: [],
    report
  };
}
function collectSkillMarkdownFiles(files, declared) {
  const declaredPaths = pathList(declared);
  const roots = declaredPaths.length > 0 ? declaredPaths : ["skills"];
  const result = /* @__PURE__ */ new Set();
  for (const root of roots) {
    if (/\.md$/i.test(root)) {
      if (files.has(root)) result.add(root);
      continue;
    }
    if (files.has(`${root}/SKILL.md`)) {
      result.add(`${root}/SKILL.md`);
      continue;
    }
    for (const path of files.keys()) {
      const normalized = normalizePath(path);
      if (normalized.startsWith(`${root}/`) && normalized.endsWith("/SKILL.md")) {
        result.add(normalized);
      }
    }
  }
  return Array.from(result).sort();
}
function convertSkillFiles(args) {
  const { files, declared, output: output2, report } = args;
  const paths = collectSkillMarkdownFiles(files, declared);
  if (!configured(declared) && files.has("SKILL.md")) paths.unshift("SKILL.md");
  const skills = [];
  let needsFilesystem = false;
  if (configured(declared) && paths.length === 0) {
    report.blocking.push({
      capability: "skills",
      path: "skills",
      message: "declared skill paths did not contain a SKILL.md file",
      blocking: true
    });
  }
  for (const skillFile of paths) {
    const text = files.get(skillFile);
    if (text === void 0) continue;
    rejectUnsupportedRuntimeTokens({
      text,
      capability: "skills",
      path: skillFile,
      report
    });
    const directory = skillFile.slice(0, Math.max(0, skillFile.lastIndexOf("/")));
    const resources = directory ? filesBelow(files, directory) : [];
    const built = buildSkill(text, resources, displayNameFromPath(directory || skillFile));
    if (built.skill.source.kind === "local-bundle" && directory) {
      built.skill.source = { kind: "local-bundle", path: directory };
    }
    skills.push(built.skill);
    needsFilesystem ||= built.needsFilesystem;
    if (!directory) {
      for (const copy of built.copies) {
        const contents = files.get(normalizePath(copy.from));
        if (contents !== void 0) output2.set(copy.to, contents);
      }
    }
    for (const warning of built.warnings) {
      report.warnings.push({
        capability: "skills",
        path: skillFile,
        message: warning,
        blocking: false
      });
    }
    report.converted.push({
      capability: "skills",
      path: skillFile,
      message: `converted skill ${built.skill.id}`,
      blocking: false
    });
  }
  return { skills, needsFilesystem };
}
function mcpDocuments(files, declared, defaultPath, rootKey = "mcpServers") {
  if (declared && typeof declared === "object" && !Array.isArray(declared)) {
    const record = declared;
    return [
      {
        path: rootKey,
        value: rootKey in record ? record : { [rootKey]: record }
      }
    ];
  }
  const paths = pathList(declared);
  if (paths.length === 0 && files.has(defaultPath)) paths.push(defaultPath);
  return paths.map((path) => {
    const text = files.get(path);
    if (text === void 0) throw new Error(`declared MCP configuration was not found: ${path}`);
    return { path, value: parseJsonObject(text, path) };
  });
}
function convertMcpDocuments(args) {
  const presets = [];
  for (const document of args.documents) {
    rejectUnsupportedRuntimeTokens({
      text: JSON.stringify(document.value),
      capability: "mcpServers",
      path: document.path,
      report: args.report
    });
    const canonicalText = JSON.stringify(replacePluginRootToken(document.value));
    const { drafts } = readMcpDrafts(canonicalText, args.adapterSourceName);
    for (const draft of drafts) {
      const preset = {
        id: draft.name,
        name: draft.name,
        description: describeConfig(draft.transport, draft.config),
        transport: draft.transport,
        config: draft.config,
        fields: []
      };
      presets.push(preset);
      args.report.converted.push({
        capability: "mcpServers",
        path: document.path,
        message: `converted MCP server ${preset.id}`,
        blocking: false
      });
    }
  }
  return presets;
}
function detectPluginEcosystem(files) {
  if (files.has("plugin.json")) return "cognia";
  if (files.has(".claude-plugin/plugin.json")) return "claude-code";
  if (files.has(".codex-plugin/plugin.json")) return "codex";
  if (files.has("gemini-extension.json")) return "gemini-cli";
  throw new Error(
    "plugin format not recognized \u2014 expected plugin.json, .claude-plugin/plugin.json, .codex-plugin/plugin.json, or gemini-extension.json"
  );
}
function convertClaudePlugin(files, options2) {
  const sourcePath = ".claude-plugin/plugin.json";
  const source = parseJsonObject(
    requiredString(files.get(sourcePath), sourcePath),
    sourcePath
  );
  const sourceRecord = source;
  const blocking = [
    ["hooks", source.hooks],
    ["lspServers", source.lspServers],
    ["outputStyles", source.outputStyles],
    ["workflows", source.workflows],
    ["settings", source.settings],
    ["userConfig", source.userConfig],
    ["channels", source.channels],
    ["dependencies", source.dependencies],
    ["experimental", source.experimental]
  ].filter(([, value]) => configured(value)).map(([capability]) => unsupportedIssue(String(capability)));
  const discoveredExecutableSurfaces = [
    ["hooks", ["hooks/", "hooks.json"]],
    ["monitors", ["monitors/"]],
    ["bin", ["bin/"]],
    ["themes", ["themes/"]],
    ["workflows", ["workflows/"]],
    ["outputStyles", ["output-styles/"]],
    ["settings", ["settings.json"]],
    ["lspServers", [".lsp.json"]]
  ];
  for (const [capability, prefixes] of discoveredExecutableSurfaces) {
    if (prefixes.some(
      (prefix) => Array.from(files.keys()).some(
        (path) => prefix.endsWith("/") ? normalizePath(path).startsWith(prefix) : normalizePath(path) === prefix
      )
    ) && !blocking.some((issue) => issue.capability === capability)) {
      blocking.push(unsupportedIssue(capability));
    }
  }
  const report = {
    fidelity: blocking.length > 0 ? "unsupported" : "structured",
    converted: [],
    warnings: [],
    blocking
  };
  reportUnknownManifestFields({
    manifest: sourceRecord,
    known: /* @__PURE__ */ new Set([
      "name",
      "displayName",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "skills",
      "commands",
      "agents",
      "mcpServers",
      "hooks",
      "lspServers",
      "outputStyles",
      "workflows",
      "settings",
      "userConfig",
      "channels",
      "dependencies",
      "experimental"
    ]),
    sourcePath,
    report
  });
  if (blocking.length > 0) {
    throw new UnsupportedPluginConversionError("claude-code", "cognia", report);
  }
  const output2 = cloneFiles(files);
  const convertedSkills = convertSkillFiles({
    files,
    declared: source.skills,
    output: output2,
    report
  });
  const skills = convertedSkills.skills;
  const commandConversionStart = report.converted.length;
  const commandPaths = pathList(source.commands, "commands");
  for (const path of commandPaths) {
    const candidates = path.toLowerCase().endsWith(".md") ? [path] : Array.from(files.keys()).filter(
      (file) => normalizePath(file).startsWith(`${path}/`) && /\.md$/i.test(file)
    );
    for (const commandPath of candidates) {
      const text = files.get(commandPath);
      if (text === void 0) continue;
      rejectUnsupportedRuntimeTokens({
        text,
        capability: "commands",
        path: commandPath,
        report
      });
      const built = buildSkill(text, [], displayNameFromPath(commandPath));
      skills.push(built.skill);
      report.converted.push({
        capability: "commands",
        path: commandPath,
        message: `converted prompt command to skill ${built.skill.id}`,
        blocking: false
      });
    }
  }
  if (configured(source.commands) && report.converted.length === commandConversionStart) {
    report.blocking.push({
      capability: "commands",
      path: "commands",
      message: "declared command paths did not contain Markdown command files",
      blocking: true
    });
  }
  const subagents = [];
  const agentConversionStart = report.converted.length;
  const agentPaths = pathList(source.agents, "agents");
  for (const path of agentPaths) {
    const candidates = path.toLowerCase().endsWith(".md") ? [path] : Array.from(files.keys()).filter(
      (file) => normalizePath(file).startsWith(`${path}/`) && /\.md$/i.test(file)
    );
    for (const agentPath of candidates) {
      const text = files.get(agentPath);
      if (text === void 0) continue;
      rejectUnsupportedRuntimeTokens({
        text,
        capability: "agents",
        path: agentPath,
        report
      });
      const agentId = slugify(displayNameFromPath(agentPath));
      const parsed = parseMarkdownAgent(agentId, text);
      if ("error" in parsed) {
        report.blocking.push({
          capability: "agents",
          path: agentPath,
          message: parsed.error,
          blocking: true
        });
        continue;
      }
      if (parsed.unsupportedFields.length > 0) {
        report.blocking.push({
          capability: "agents",
          path: agentPath,
          message: `unsupported subagent fields: ${parsed.unsupportedFields.join(", ")}`,
          blocking: true
        });
        continue;
      }
      subagents.push({
        id: parsed.id,
        name: parsed.id,
        ...parsed.def
      });
      report.converted.push({
        capability: "agents",
        path: agentPath,
        message: `converted subagent ${parsed.id}`,
        blocking: false
      });
    }
  }
  if (configured(source.agents) && report.converted.length === agentConversionStart) {
    report.blocking.push({
      capability: "agents",
      path: "agents",
      message: "declared agent paths did not contain valid Markdown agents",
      blocking: true
    });
  }
  const presets = convertMcpDocuments({
    documents: mcpDocuments(files, source.mcpServers, ".mcp.json"),
    adapterSourceName: "claude-code.json",
    report
  });
  return finalizeForeignConversion({
    source: "claude-code",
    output: output2,
    metadata: metadataFromForeignManifest(sourceRecord, sourcePath),
    contributions: {
      skills,
      subagents,
      presets,
      needsFilesystem: convertedSkills.needsFilesystem
    },
    report,
    options: options2
  });
}
function convertCodexPlugin(files, options2) {
  const sourcePath = ".codex-plugin/plugin.json";
  const source = parseJsonObject(requiredString(files.get(sourcePath), sourcePath), sourcePath);
  const blocking = [
    ["hooks", source.hooks],
    ["apps", source.apps]
  ].filter(([, value]) => configured(value)).map(([capability]) => unsupportedIssue(String(capability)));
  const report = {
    fidelity: blocking.length > 0 ? "unsupported" : "structured",
    converted: [],
    warnings: [],
    blocking
  };
  reportUnknownManifestFields({
    manifest: source,
    known: /* @__PURE__ */ new Set([
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "skills",
      "hooks",
      "mcpServers",
      "apps",
      "interface"
    ]),
    sourcePath,
    report
  });
  const output2 = cloneFiles(files);
  const convertedSkills = convertSkillFiles({
    files,
    declared: source.skills,
    output: output2,
    report
  });
  const presets = convertMcpDocuments({
    documents: mcpDocuments(files, source.mcpServers, ".mcp.json"),
    adapterSourceName: "claude-code.json",
    report
  });
  const interfaceMetadata = source.interface && typeof source.interface === "object" && !Array.isArray(source.interface) ? source.interface : void 0;
  const mappedInterfaceFields = /* @__PURE__ */ new Set(["displayName", "shortDescription", "screenshots"]);
  if (interfaceMetadata && !optionalString(source.description) && optionalString(interfaceMetadata.longDescription)) {
    source.description = interfaceMetadata.longDescription;
    mappedInterfaceFields.add("longDescription");
  }
  if (interfaceMetadata && !configured(source.author) && optionalString(interfaceMetadata.developerName)) {
    source.author = { name: interfaceMetadata.developerName };
    mappedInterfaceFields.add("developerName");
  }
  if (interfaceMetadata && !optionalString(source.homepage) && optionalString(interfaceMetadata.websiteURL)) {
    mappedInterfaceFields.add("websiteURL");
  }
  if (interfaceMetadata) {
    if (optionalString(interfaceMetadata.logo)) {
      mappedInterfaceFields.add("logo");
    } else if (optionalString(interfaceMetadata.composerIcon)) {
      mappedInterfaceFields.add("composerIcon");
    }
  }
  reportUnmappedPresentationFields(interfaceMetadata, mappedInterfaceFields, report);
  return finalizeForeignConversion({
    source: "codex",
    output: output2,
    metadata: metadataFromForeignManifest(source, sourcePath, interfaceMetadata),
    contributions: {
      skills: convertedSkills.skills,
      subagents: [],
      presets,
      needsFilesystem: convertedSkills.needsFilesystem
    },
    report,
    options: options2
  });
}
function parseGeminiCommand(path, text, report) {
  let parsed;
  try {
    parsed = parse16(text);
  } catch (error) {
    report.blocking.push({
      capability: "commands",
      path,
      message: `invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
      blocking: true
    });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    report.blocking.push({
      capability: "commands",
      path,
      message: "command TOML must contain an object",
      blocking: true
    });
    return null;
  }
  const command = parsed;
  const prompt = optionalString(command.prompt);
  if (!prompt) {
    report.blocking.push({
      capability: "commands",
      path,
      message: "command is missing the required prompt string",
      blocking: true
    });
    return null;
  }
  if (/!\{[\s\S]*\}/.test(prompt)) {
    report.blocking.push({
      capability: "commands",
      path,
      message: "shell interpolation cannot be executed by a declarative Cognia skill",
      blocking: true
    });
    return null;
  }
  const relative2 = normalizePath(path).replace(/^commands\//, "").replace(/\.toml$/i, "");
  const id = slugify(relative2.replaceAll("/", "-"));
  report.warnings.push({
    capability: "commands",
    path,
    message: "converted to a contextual skill; Gemini command argument and file interpolation markers remain literal",
    blocking: false
  });
  report.converted.push({
    capability: "commands",
    path,
    message: `converted prompt command to skill ${id}`,
    blocking: false
  });
  return {
    id,
    name: relative2.replaceAll("/", ":"),
    description: optionalString(command.description) ?? "",
    source: { kind: "inline", markdown: prompt }
  };
}
function convertGeminiPlugin(files, options2) {
  const sourcePath = "gemini-extension.json";
  const source = parseJsonObject(requiredString(files.get(sourcePath), sourcePath), sourcePath);
  const blocking = configured(source.excludeTools) ? [unsupportedIssue("excludeTools")] : [];
  const report = {
    fidelity: blocking.length > 0 ? "unsupported" : "structured",
    converted: [],
    warnings: [],
    blocking
  };
  reportUnknownManifestFields({
    manifest: source,
    known: /* @__PURE__ */ new Set([
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "contextFileName",
      "excludeTools",
      "mcpServers"
    ]),
    sourcePath,
    report
  });
  const output2 = cloneFiles(files);
  const skills = [];
  const contextPath = optionalString(source.contextFileName) ?? "GEMINI.md";
  const context = files.get(normalizePath(contextPath));
  if (context !== void 0 && context.trim()) {
    rejectUnsupportedRuntimeTokens({
      text: context,
      capability: "context",
      path: contextPath,
      report
    });
    skills.push({
      id: "gemini-context",
      name: "Gemini Context",
      description: "Extension context imported from Gemini CLI.",
      source: { kind: "inline", markdown: context.trim() }
    });
    report.converted.push({
      capability: "context",
      path: contextPath,
      message: "converted extension context to a skill",
      blocking: false
    });
  } else if (source.contextFileName !== void 0) {
    report.blocking.push({
      capability: "context",
      path: contextPath,
      message: "declared context file was not found or was empty",
      blocking: true
    });
  }
  for (const path of Array.from(files.keys()).map(normalizePath).sort()) {
    if (!path.startsWith("commands/") || !path.endsWith(".toml")) continue;
    const skill = parseGeminiCommand(path, requiredString(files.get(path), path), report);
    if (skill) skills.push(skill);
  }
  if (report.warnings.some((issue) => issue.capability === "commands")) {
    report.fidelity = "contextual";
  }
  const presets = convertMcpDocuments({
    documents: mcpDocuments(files, source.mcpServers, ".mcp.json"),
    adapterSourceName: "gemini.json",
    report
  });
  return finalizeForeignConversion({
    source: "gemini-cli",
    output: output2,
    metadata: metadataFromForeignManifest(source, sourcePath),
    contributions: {
      skills,
      subagents: [],
      presets,
      needsFilesystem: false
    },
    report,
    options: options2
  });
}
function loadCogniaPlugin(files) {
  const manifest = parseExistingManifest(
    requiredString(files.get("plugin.json"), "plugin.json"),
    "plugin.json"
  );
  return {
    source: "cognia",
    target: "cognia",
    manifest,
    files: new Map(files),
    copies: [],
    report: {
      fidelity: "native-exact",
      converted: [],
      warnings: [],
      blocking: []
    }
  };
}
function replaceCanonicalRootToken(value, target) {
  const token = target === "claude-code" ? "${CLAUDE_PLUGIN_ROOT}" : target === "gemini-cli" ? "${extensionPath}" : "${CODEX_PLUGIN_ROOT}";
  if (typeof value === "string") {
    return value.replaceAll("${COGNIA_PLUGIN_ROOT}", token);
  }
  if (Array.isArray(value)) return value.map((item) => replaceCanonicalRootToken(item, target));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceCanonicalRootToken(item, target)])
    );
  }
  return value;
}
function exportCogniaSkills(args) {
  for (const skill of args.manifest.skills ?? []) {
    const targetDirectory = `skills/${skill.id}`;
    if (skill.source.kind === "inline") {
      args.output.set(
        `${targetDirectory}/SKILL.md`,
        serializeSkill({
          name: skill.name,
          description: skill.description,
          content: skill.source.markdown,
          allowedTools: skill.allowedTools
        })
      );
    } else if (skill.source.kind === "local-folder" || skill.source.kind === "local-bundle") {
      if (args.target === "gemini-cli") {
        args.report.blocking.push({
          capability: "skills",
          path: `skills.${skill.id}.source`,
          message: "Gemini prompt commands cannot preserve a resource-bearing Cognia skill",
          blocking: true
        });
        continue;
      }
      const sourceDirectory = normalizePath(skill.source.path);
      const entries = Array.from(args.files.entries()).filter(
        ([path]) => normalizePath(path).startsWith(`${sourceDirectory}/`)
      );
      if (entries.length === 0) {
        args.report.blocking.push({
          capability: "skills",
          path: skill.source.path,
          message: `skill bundle ${skill.id} was not found`,
          blocking: true
        });
        continue;
      }
      for (const [path, contents] of entries) {
        const relative2 = normalizePath(path).slice(sourceDirectory.length + 1);
        const normalizedSource = normalizePath(path);
        const target = `${targetDirectory}/${relative2}`;
        if (args.binaryPaths?.has(normalizedSource)) {
          args.copies.push({ from: normalizedSource, to: target });
        } else {
          args.output.set(target, contents);
        }
      }
    } else {
      args.report.blocking.push({
        capability: "skills",
        path: `skills.${skill.id}.source`,
        message: `${skill.source.kind} skills cannot be represented as a self-contained ${args.target} bundle`,
        blocking: true
      });
      continue;
    }
    args.report.converted.push({
      capability: "skills",
      path: `skills.${skill.id}`,
      message: `exported skill ${skill.id}`,
      blocking: false
    });
  }
}
function exportCogniaSubagents(args) {
  const subagents = args.manifest.subagents ?? [];
  if (subagents.length === 0) return;
  if (args.target !== "claude-code") {
    args.report.blocking.push({
      capability: "subagent",
      path: "subagents",
      message: `${args.target} plugins do not expose a compatible subagent contribution`,
      blocking: true
    });
    return;
  }
  for (const agent of subagents) {
    const unsupported = [
      agent.provider,
      agent.externalPresetId,
      agent.mcpServerIds?.length,
      agent.allowNesting,
      agent.maxDepth,
      agent.hidden,
      agent.disabled
    ].some(configured);
    if (unsupported) {
      args.report.blocking.push({
        capability: "subagent",
        path: `subagents.${agent.id}`,
        message: "subagent contains Cognia-only routing, nesting, or visibility controls",
        blocking: true
      });
      continue;
    }
    args.output.set(
      `agents/${agent.id}.md`,
      serializeMarkdownAgent(agent.id, {
        description: agent.description,
        prompt: agent.prompt,
        tools: agent.tools,
        disallowedTools: agent.disallowedTools,
        model: agent.model,
        maxTurns: agent.maxTurns,
        effort: agent.effort
      })
    );
    args.report.converted.push({
      capability: "subagent",
      path: `subagents.${agent.id}`,
      message: `exported subagent ${agent.id}`,
      blocking: false
    });
  }
}
function exportMcpServers(args) {
  const presets = args.manifest.mcpServerPresets ?? [];
  if (presets.length === 0) return void 0;
  const servers = [];
  for (const preset of presets) {
    if (preset.fields?.length) {
      args.report.blocking.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}.fields`,
        message: "target plugin formats cannot prompt users for Cognia preset fields",
        blocking: true
      });
      continue;
    }
    if (args.target === "codex" && preset.transport === "sse") {
      args.report.blocking.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}.transport`,
        message: "Codex plugins do not support SSE MCP transport",
        blocking: true
      });
      continue;
    }
    servers.push({
      id: preset.id,
      name: preset.id,
      transport: preset.transport,
      config: replaceCanonicalRootToken(preset.config, args.target),
      enabled: true,
      createdAt: 0,
      updatedAt: 0
    });
  }
  if (servers.length === 0) return void 0;
  const adapterId = args.target === "gemini-cli" ? "gemini" : "claude-code";
  const adapter = MCP_AGENT_ADAPTERS.find((candidate) => candidate.id === adapterId);
  if (!adapter) throw new Error(`missing MCP adapter: ${adapterId}`);
  const projected = adapter.project(null, servers);
  if (!projected || typeof projected !== "object" || Array.isArray(projected)) {
    throw new Error(`${adapterId} MCP adapter returned an invalid projection`);
  }
  for (const preset of presets) {
    args.report.converted.push({
      capability: "mcp-server-preset",
      path: `mcpServerPresets.${preset.id}`,
      message: `exported MCP server ${preset.id}`,
      blocking: false
    });
  }
  return projected;
}
function authorForForeign(manifest) {
  if (!manifest.author) return void 0;
  return {
    name: manifest.author.name,
    ...manifest.author.email ? { email: manifest.author.email } : {},
    ...manifest.author.url ? { url: manifest.author.url } : {}
  };
}
function convertCogniaPlugin(files, target, options2) {
  const loaded = loadCogniaPlugin(files);
  const { manifest } = loaded;
  const report = {
    fidelity: target === "gemini-cli" ? "contextual" : "structured",
    converted: [],
    warnings: [],
    blocking: []
  };
  const allowedCapabilities = /* @__PURE__ */ new Set([
    "skills",
    "mcp-server-preset",
    ...target === "claude-code" ? ["subagent"] : []
  ]);
  for (const capability of manifest.capabilities ?? []) {
    if (!allowedCapabilities.has(capability)) {
      report.blocking.push(unsupportedIssue(capability));
    }
  }
  if (manifest.permissions?.length) {
    report.blocking.push(unsupportedIssue("permissions"));
  }
  const executableEntries = [manifest.pythonMain, manifest.wasmMain, manifest.vscodeMain].filter(
    configured
  );
  if (executableEntries.length > 0) {
    report.blocking.push(unsupportedIssue("runtime"));
  }
  if (manifest.main) {
    const entry = files.get(normalizePath(manifest.main));
    if (!entry?.includes("Built output of src/index.ts, pre-generated by `cognia plugin import`")) {
      report.blocking.push({
        capability: "runtime",
        path: manifest.main,
        message: "imperative Cognia activation code cannot be translated declaratively",
        blocking: true
      });
    }
  }
  const output2 = /* @__PURE__ */ new Map();
  const copies = [];
  exportCogniaSkills({
    manifest,
    files,
    output: output2,
    target,
    report,
    copies,
    binaryPaths: options2.binaryPaths
  });
  exportCogniaSubagents({ manifest, output: output2, target, report });
  const mcp = exportMcpServers({ manifest, output: output2, target, report });
  if (report.blocking.length > 0) {
    report.fidelity = "unsupported";
    throw new UnsupportedPluginConversionError("cognia", target, report);
  }
  const baseManifest = {
    name: manifest.id,
    version: manifest.version,
    description: manifest.description,
    author: authorForForeign(manifest),
    homepage: manifest.homepage,
    repository: manifest.repository,
    license: manifest.license,
    keywords: manifest.keywords
  };
  if (target === "claude-code") {
    output2.set(
      ".claude-plugin/plugin.json",
      `${JSON.stringify(
        {
          ...baseManifest,
          displayName: manifest.name,
          ...manifest.skills?.length ? { skills: "./skills" } : {},
          ...manifest.subagents?.length ? { agents: "./agents" } : {},
          ...mcp ? { mcpServers: "./.mcp.json" } : {}
        },
        null,
        2
      )}
`
    );
    if (mcp) output2.set(".mcp.json", `${JSON.stringify(mcp, null, 2)}
`);
  } else if (target === "codex") {
    output2.set(
      ".codex-plugin/plugin.json",
      `${JSON.stringify(
        {
          ...baseManifest,
          ...manifest.skills?.length ? { skills: "./skills" } : {},
          ...mcp ? { mcpServers: "./.mcp.json" } : {},
          interface: {
            displayName: manifest.name,
            shortDescription: manifest.description
          }
        },
        null,
        2
      )}
`
    );
    if (mcp) output2.set(".mcp.json", `${JSON.stringify(mcp, null, 2)}
`);
  } else {
    const geminiServers = mcp && typeof mcp.mcpServers === "object" && mcp.mcpServers ? mcp.mcpServers : void 0;
    for (const skill of manifest.skills ?? []) {
      const skillFile = output2.get(`skills/${skill.id}/SKILL.md`);
      if (skillFile === void 0) continue;
      const parsed = buildSkill(skillFile, [], skill.name).skill;
      const markdown = parsed.source.kind === "inline" ? parsed.source.markdown : skillFile;
      output2.set(
        `commands/${skill.id}.toml`,
        stringify({
          description: skill.description,
          prompt: markdown
        })
      );
      report.warnings.push({
        capability: "skills",
        path: `skills.${skill.id}`,
        message: "exported as a Gemini prompt command; autonomous skill activation is contextual",
        blocking: false
      });
    }
    for (const path of Array.from(output2.keys())) {
      if (path.startsWith("skills/")) output2.delete(path);
    }
    output2.set(
      "gemini-extension.json",
      `${JSON.stringify(
        {
          name: manifest.id,
          version: manifest.version,
          description: manifest.description,
          ...geminiServers ? { mcpServers: geminiServers } : {}
        },
        null,
        2
      )}
`
    );
  }
  return {
    source: "cognia",
    target,
    manifest,
    files: output2,
    copies,
    report
  };
}
function convertPluginBundle(files, target, options2 = {}) {
  const source = detectPluginEcosystem(files);
  if (source === target && source === "cognia") return loadCogniaPlugin(files);
  if (source === "claude-code" && target === "cognia") {
    return convertClaudePlugin(files, options2);
  }
  if (source === "codex" && target === "cognia") {
    return convertCodexPlugin(files, options2);
  }
  if (source === "gemini-cli" && target === "cognia") {
    return convertGeminiPlugin(files, options2);
  }
  if (source === "cognia" && target !== "cognia") {
    return convertCogniaPlugin(files, target, options2);
  }
  const report = {
    fidelity: "unsupported",
    converted: [],
    warnings: [],
    blocking: [
      {
        capability: "format",
        path: source,
        message: `conversion from ${source} to ${target} is not implemented`,
        blocking: true
      }
    ]
  };
  throw new UnsupportedPluginConversionError(source, target, report);
}

// lib/plugin/convert/cli.ts
var SOURCE_KINDS = ["mcp", "skill", "cli"];
var VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--from",
  "--input",
  "--pick",
  "--into",
  "--dir",
  "--id",
  "--name",
  "--description",
  "--plugin-version",
  "--author",
  "--author-email",
  "--license",
  "--min-app-version",
  "--host-version"
]);
function parseArgs(argv) {
  const values = /* @__PURE__ */ new Map();
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      list = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      throw new Error(`unknown option: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === void 0 || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    values.set(arg, value);
    i += 1;
  }
  const from = values.get("--from");
  if (!from) throw new Error("--from is required (mcp | skill | cli)");
  if (!SOURCE_KINDS.includes(from)) {
    throw new Error(`--from must be one of ${SOURCE_KINDS.join(" | ")}, got "${from}"`);
  }
  const input = values.get("--input");
  if (!input) throw new Error("--input is required");
  return {
    from,
    input,
    pick: values.get("--pick"),
    into: values.get("--into"),
    dir: values.get("--dir"),
    list,
    hostVersion: values.get("--host-version"),
    identity: {
      id: values.get("--id"),
      name: values.get("--name"),
      description: values.get("--description"),
      version: values.get("--plugin-version"),
      author: values.get("--author"),
      authorEmail: values.get("--author-email"),
      license: values.get("--license"),
      minAppVersion: values.get("--min-app-version")
    }
  };
}
function readSource(args, io) {
  if (args.from === "cli") return {};
  const path = io.resolve(args.input);
  if (!io.exists(path)) throw new Error(`no such file or directory: ${path}`);
  if (args.from === "mcp") {
    if (io.isDirectory(path)) {
      throw new Error(
        `--input must be an agent config file for --from mcp, got a directory: ${path}`
      );
    }
    return { text: io.readFile(path), sourceName: args.input };
  }
  const skillRoot = io.isDirectory(path) ? path : dirnameOf(path);
  const skillMd = io.isDirectory(path) ? io.join(path, "SKILL.md") : path;
  if (!io.exists(skillMd)) {
    throw new Error(`no SKILL.md in ${skillRoot}`);
  }
  const resources = io.listFiles(skillRoot).filter((rel) => rel !== "SKILL.md").sort();
  return {
    text: io.readFile(skillMd),
    sourceName: io.basename(skillRoot),
    resources,
    skillRoot
  };
}
function dirnameOf(path) {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx <= 0 ? path : path.slice(0, idx);
}
function assertWritableTarget(dir, io) {
  if (!io.exists(dir)) return;
  if (!io.isDirectory(dir)) throw new Error(`${dir} exists and is not a directory`);
  const entries = io.readDir(dir).filter((name) => name !== "." && name !== "..");
  if (entries.length > 0) {
    throw new Error(
      `${dir} is not empty \u2014 pass --dir to choose another location, or --into <dir> to add this contribution to the plugin already there`
    );
  }
}
var ECOSYSTEM_TARGETS = ["cognia", "claude-code", "codex", "gemini-cli"];
var BUNDLE_TEXT_PATTERN = /\.(?:md|markdown|txt|json|jsonc|toml|ya?ml|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rs|css|html)$/i;
function parseEcosystemArgs(argv) {
  const allowed = /* @__PURE__ */ new Set(["--operation", "--from", "--input", "--to", "--dir"]);
  const values = /* @__PURE__ */ new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!allowed.has(flag)) throw new Error(`unknown option: ${flag}`);
    const value = argv[i + 1];
    if (value === void 0 || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    values.set(flag, value);
    i += 1;
  }
  const operation = values.get("--operation") ?? "import";
  if (operation !== "import" && operation !== "export") {
    throw new Error(`--operation must be import or export, got "${operation}"`);
  }
  if (operation === "import" && values.get("--from") !== "plugin") {
    throw new Error("plugin bundle import requires `--from plugin`");
  }
  const input = values.get("--input");
  if (!input) throw new Error("--input is required");
  const target = values.get("--to") ?? (operation === "import" ? "cognia" : "");
  if (!ECOSYSTEM_TARGETS.includes(target)) {
    throw new Error(`--to must be one of ${ECOSYSTEM_TARGETS.join(" | ")}, got "${target}"`);
  }
  if (operation === "export" && target === "cognia") {
    throw new Error("plugin export requires --to claude-code, codex, or gemini-cli");
  }
  return {
    operation,
    input,
    target,
    dir: values.get("--dir")
  };
}
function runEcosystemConvertCli(argv, io) {
  const args = parseEcosystemArgs(argv);
  const sourceRoot = io.resolve(args.input);
  if (!io.exists(sourceRoot)) throw new Error(`no such file or directory: ${sourceRoot}`);
  if (!io.isDirectory(sourceRoot)) {
    throw new Error(`plugin bundle input must be a directory: ${sourceRoot}`);
  }
  const files = /* @__PURE__ */ new Map();
  const binaryPaths = /* @__PURE__ */ new Set();
  for (const relative2 of io.listFiles(sourceRoot).sort()) {
    const normalized = relative2.replaceAll("\\", "/");
    if (BUNDLE_TEXT_PATTERN.test(normalized)) {
      files.set(normalized, io.readFile(io.join(sourceRoot, relative2)));
    } else {
      files.set(normalized, "");
      binaryPaths.add(normalized);
    }
  }
  const result = convertPluginBundle(files, args.target, { binaryPaths });
  const defaultDir = args.operation === "import" ? result.manifest.id : `${result.manifest.id}-${args.target}`;
  const outputDir = io.resolve(args.dir ?? defaultDir);
  assertWritableTarget(outputDir, io);
  const written = [];
  const copies = [...result.copies];
  for (const [relative2, contents] of result.files) {
    if (binaryPaths.has(relative2) && contents === "") {
      copies.push({ from: relative2, to: relative2 });
      continue;
    }
    const target = io.join(outputDir, relative2);
    io.mkdirp(dirnameOf(target));
    io.writeFile(target, contents);
    written.push(relative2);
  }
  const seenCopies = /* @__PURE__ */ new Set();
  for (const copy of copies) {
    const key = `${copy.from}\0${copy.to}`;
    if (seenCopies.has(key)) continue;
    seenCopies.add(key);
    const target = io.join(outputDir, copy.to);
    io.mkdirp(dirnameOf(target));
    io.copyFile(io.join(sourceRoot, copy.from), target);
    written.push(copy.to);
  }
  return {
    ok: true,
    mode: args.operation === "export" ? "export" : "create",
    pluginId: result.manifest.id,
    dir: outputDir,
    files: written.sort(),
    warnings: result.report.warnings.map((issue) => `${issue.path}: ${issue.message}`)
  };
}
function runConvertCli(argv, io) {
  const args = parseArgs(argv);
  const source = readSource(args, io);
  const input = {
    kind: args.from,
    text: source.text,
    sourceName: source.sourceName,
    resources: source.resources,
    binary: args.from === "cli" ? args.input : void 0,
    pick: args.pick,
    identity: args.identity
  };
  if (args.list) {
    return { ok: true, mode: "list", candidates: listCandidates(input) };
  }
  if (!args.pick) {
    const candidates = listCandidates(input);
    if (candidates.length === 1) input.pick = candidates[0].id;
  }
  if (args.into) {
    const intoDir = io.resolve(args.into);
    const manifestPath = io.join(intoDir, "plugin.json");
    if (!io.exists(manifestPath)) {
      throw new Error(`${manifestPath} not found \u2014 --into expects an existing plugin directory`);
    }
    const result2 = convert(input, {
      hostVersion: args.hostVersion,
      gitAuthor: io.gitAuthor(),
      existingManifestText: io.readFile(manifestPath),
      existingManifestPath: manifestPath
    });
    io.writeFile(manifestPath, result2.files.get("plugin.json"));
    copyResources(result2.copies, source.skillRoot, intoDir, io);
    return {
      ok: true,
      mode: "merge",
      pluginId: result2.pluginId,
      dir: intoDir,
      files: ["plugin.json", ...result2.copies.map((c) => c.to)],
      todos: result2.todos,
      warnings: result2.warnings
    };
  }
  const result = convert(input, {
    hostVersion: args.hostVersion,
    gitAuthor: io.gitAuthor()
  });
  const dir = io.resolve(args.dir ?? result.pluginId);
  assertWritableTarget(dir, io);
  const written = [];
  for (const [relative2, contents] of result.files) {
    const target = io.join(dir, relative2);
    io.mkdirp(dirnameOf(target));
    io.writeFile(target, contents);
    written.push(relative2);
  }
  written.push(...copyResources(result.copies, source.skillRoot, dir, io));
  return {
    ok: true,
    mode: "create",
    pluginId: result.pluginId,
    dir,
    files: written.sort(),
    todos: result.todos,
    warnings: result.warnings,
    buildTarget: "dist/index.js"
  };
}
function copyResources(copies, sourceRoot, targetDir, io) {
  if (copies.length === 0) return [];
  if (!sourceRoot) {
    throw new Error("internal: resource copies requested without a source directory");
  }
  const written = [];
  for (const copy of copies) {
    const target = io.join(targetDir, copy.to);
    io.mkdirp(dirnameOf(target));
    io.copyFile(io.join(sourceRoot, copy.from), target);
    written.push(copy.to);
  }
  return written;
}
function runMain(argv, io) {
  try {
    const fromIndex = argv.indexOf("--from");
    const wholePlugin = argv.includes("--operation") || fromIndex >= 0 && argv[fromIndex + 1] === "plugin";
    const result = wholePlugin ? runEcosystemConvertCli(argv, io) : runConvertCli(argv, io);
    return { output: JSON.stringify(result), exitCode: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { output: JSON.stringify({ ok: false, error: message }), exitCode: 1 };
  }
}

// lib/plugin/convert/node-io.ts
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var SKIPPED_DIRS = /* @__PURE__ */ new Set([".git", "node_modules", ".DS_Store"]);
function walk(root, current, out) {
  for (const entry of (0, import_node_fs.readdirSync)(current, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = (0, import_node_path.join)(current, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, out);
    } else if (entry.isFile()) {
      out.push((0, import_node_path.relative)(root, full).split("\\").join("/"));
    }
  }
}
var nodeIo = {
  readFile: (path) => (0, import_node_fs.readFileSync)(path, "utf8"),
  writeFile: (path, contents) => (0, import_node_fs.writeFileSync)(path, contents, "utf8"),
  copyFile: (from, to) => (0, import_node_fs.copyFileSync)(from, to),
  mkdirp: (path) => {
    (0, import_node_fs.mkdirSync)(path, { recursive: true });
  },
  exists: (path) => (0, import_node_fs.existsSync)(path),
  isDirectory: (path) => (0, import_node_fs.existsSync)(path) && (0, import_node_fs.statSync)(path).isDirectory(),
  readDir: (path) => (0, import_node_fs.readdirSync)(path),
  listFiles: (path) => {
    const out = [];
    walk(path, path, out);
    return out;
  },
  join: (...segments) => (0, import_node_path.join)(...segments),
  basename: (path) => (0, import_node_path.basename)(path),
  resolve: (path) => (0, import_node_path.resolve)(path),
  gitAuthor: () => {
    try {
      const name = (0, import_node_child_process.execFileSync)("git", ["config", "user.name"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      return name || void 0;
    } catch {
      return void 0;
    }
  }
};

// lib/plugin/convert/bin.ts
var { output, exitCode } = runMain(process.argv.slice(2), nodeIo);
process.stdout.write(output);
process.exitCode = exitCode;
