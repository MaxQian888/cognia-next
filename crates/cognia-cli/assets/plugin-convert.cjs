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
      var defaults = { section_delimiter: "---", parse: identity2 };
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
    function identity2(val) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/common.js
var require_common = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/common.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/exception.js
var require_exception = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/exception.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/mark.js
var require_mark = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/mark.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type.js
var require_type = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema.js
var require_schema = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/str.js
var require_str = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/str.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/seq.js
var require_seq = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/seq.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/map.js
var require_map = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/map.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema/failsafe.js
var require_failsafe = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema/failsafe.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/null.js
var require_null = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/null.js"(exports2, module2) {
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
    function isNull(object2) {
      return object2 === null;
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/bool.js
var require_bool = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/bool.js"(exports2, module2) {
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
    function isBoolean(object2) {
      return Object.prototype.toString.call(object2) === "[object Boolean]";
    }
    module2.exports = new Type("tag:yaml.org,2002:bool", {
      kind: "scalar",
      resolve: resolveYamlBoolean,
      construct: constructYamlBoolean,
      predicate: isBoolean,
      represent: {
        lowercase: function(object2) {
          return object2 ? "true" : "false";
        },
        uppercase: function(object2) {
          return object2 ? "TRUE" : "FALSE";
        },
        camelcase: function(object2) {
          return object2 ? "True" : "False";
        }
      },
      defaultStyle: "lowercase"
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/int.js
var require_int = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/int.js"(exports2, module2) {
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
    function isInteger(object2) {
      return Object.prototype.toString.call(object2) === "[object Number]" && (object2 % 1 === 0 && !common.isNegativeZero(object2));
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/float.js
var require_float = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/float.js"(exports2, module2) {
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
    function representYamlFloat(object2, style) {
      var res;
      if (isNaN(object2)) {
        switch (style) {
          case "lowercase":
            return ".nan";
          case "uppercase":
            return ".NAN";
          case "camelcase":
            return ".NaN";
        }
      } else if (Number.POSITIVE_INFINITY === object2) {
        switch (style) {
          case "lowercase":
            return ".inf";
          case "uppercase":
            return ".INF";
          case "camelcase":
            return ".Inf";
        }
      } else if (Number.NEGATIVE_INFINITY === object2) {
        switch (style) {
          case "lowercase":
            return "-.inf";
          case "uppercase":
            return "-.INF";
          case "camelcase":
            return "-.Inf";
        }
      } else if (common.isNegativeZero(object2)) {
        return "-0.0";
      }
      res = object2.toString(10);
      return SCIENTIFIC_WITHOUT_DOT.test(res) ? res.replace("e", ".e") : res;
    }
    function isFloat(object2) {
      return Object.prototype.toString.call(object2) === "[object Number]" && (object2 % 1 !== 0 || common.isNegativeZero(object2));
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema/json.js
var require_json = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema/json.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema/core.js
var require_core = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema/core.js"(exports2, module2) {
    "use strict";
    var Schema = require_schema();
    module2.exports = new Schema({
      include: [
        require_json()
      ]
    });
  }
});

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/timestamp.js"(exports2, module2) {
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
    function representYamlTimestamp(object2) {
      return object2.toISOString();
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/merge.js
var require_merge = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/merge.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/binary.js
var require_binary = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/binary.js"(exports2, module2) {
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
    function representYamlBinary(object2) {
      var result = "", bits = 0, idx, tail, max = object2.length, map = BASE64_MAP;
      for (idx = 0; idx < max; idx++) {
        if (idx % 3 === 0 && idx) {
          result += map[bits >> 18 & 63];
          result += map[bits >> 12 & 63];
          result += map[bits >> 6 & 63];
          result += map[bits & 63];
        }
        bits = (bits << 8) + object2[idx];
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
    function isBinary(object2) {
      return NodeBuffer && NodeBuffer.isBuffer(object2);
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/omap.js
var require_omap = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/omap.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    var _hasOwnProperty = Object.prototype.hasOwnProperty;
    var _toString = Object.prototype.toString;
    function resolveYamlOmap(data) {
      if (data === null) return true;
      var objectKeys = {}, index, length, pair, pairKey, pairHasKey, object2 = data;
      for (index = 0, length = object2.length; index < length; index += 1) {
        pair = object2[index];
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/pairs.js
var require_pairs = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/pairs.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    var _toString = Object.prototype.toString;
    function resolveYamlPairs(data) {
      if (data === null) return true;
      var index, length, pair, keys, result, object2 = data;
      result = new Array(object2.length);
      for (index = 0, length = object2.length; index < length; index += 1) {
        pair = object2[index];
        if (_toString.call(pair) !== "[object Object]") return false;
        keys = Object.keys(pair);
        if (keys.length !== 1) return false;
        result[index] = [keys[0], pair[keys[0]]];
      }
      return true;
    }
    function constructYamlPairs(data) {
      if (data === null) return [];
      var index, length, pair, keys, result, object2 = data;
      result = new Array(object2.length);
      for (index = 0, length = object2.length; index < length; index += 1) {
        pair = object2[index];
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/set.js
var require_set = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/set.js"(exports2, module2) {
    "use strict";
    var Type = require_type();
    var _hasOwnProperty = Object.prototype.hasOwnProperty;
    function resolveYamlSet(data) {
      if (data === null) return true;
      var key, object2 = data;
      for (key in object2) {
        if (_hasOwnProperty.call(object2, key)) {
          if (object2[key] !== null) return false;
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema/default_safe.js
var require_default_safe = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema/default_safe.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/js/undefined.js
var require_undefined = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/js/undefined.js"(exports2, module2) {
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
    function isUndefined(object2) {
      return typeof object2 === "undefined";
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/js/regexp.js
var require_regexp = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/js/regexp.js"(exports2, module2) {
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
    function representJavascriptRegExp(object2) {
      var result = "/" + object2.source + "/";
      if (object2.global) result += "g";
      if (object2.multiline) result += "m";
      if (object2.ignoreCase) result += "i";
      return result;
    }
    function isRegExp(object2) {
      return Object.prototype.toString.call(object2) === "[object RegExp]";
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/js/function.js
var require_function = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/type/js/function.js"(exports2, module2) {
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
    function representJavascriptFunction(object2) {
      return object2.toString();
    }
    function isFunction(object2) {
      return Object.prototype.toString.call(object2) === "[object Function]";
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema/default_full.js
var require_default_full = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/schema/default_full.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/loader.js
var require_loader = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/loader.js"(exports2, module2) {
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
    function setProperty2(object2, key, value) {
      if (key === "__proto__") {
        Object.defineProperty(object2, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value
        });
      } else {
        object2[key] = value;
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
    function chargeMergeWork(state) {
      state.totalMergeKeys += 1;
      if (state.maxTotalMergeKeys !== -1 && state.totalMergeKeys > state.maxTotalMergeKeys) {
        throwError(state, "merge keys exceeded maxTotalMergeKeys (" + state.maxTotalMergeKeys + ")");
      }
    }
    function mergeMappings(state, destination, source, overridableKeys) {
      var sourceKeys, key, index, quantity;
      if (!common.isObject(source)) {
        throwError(state, "cannot merge mappings; the provided source object is unacceptable");
      }
      chargeMergeWork(state);
      sourceKeys = Object.keys(source);
      for (index = 0, quantity = sourceKeys.length; index < quantity; index += 1) {
        key = sourceKeys[index];
        chargeMergeWork(state);
        if (!_hasOwnProperty.call(destination, key)) {
          setProperty2(destination, key, source[key]);
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
          if (valueNode.length > 100) {
            throwError(state, "abnormal merge sequence size");
          }
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
        setProperty2(_result, keyNode, valueNode);
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/dumper.js
var require_dumper = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml/dumper.js"(exports2, module2) {
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
    function writeFlowSequence(state, level, object2) {
      var _result = "", _tag = state.tag, index, length;
      for (index = 0, length = object2.length; index < length; index += 1) {
        if (writeNode(state, level, object2[index], false, false)) {
          if (index !== 0) _result += "," + (!state.condenseFlow ? " " : "");
          _result += state.dump;
        }
      }
      state.tag = _tag;
      state.dump = "[" + _result + "]";
    }
    function writeBlockSequence(state, level, object2, compact) {
      var _result = "", _tag = state.tag, index, length;
      for (index = 0, length = object2.length; index < length; index += 1) {
        if (writeNode(state, level + 1, object2[index], true, true)) {
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
    function writeFlowMapping(state, level, object2) {
      var _result = "", _tag = state.tag, objectKeyList = Object.keys(object2), index, length, objectKey, objectValue, pairBuffer;
      for (index = 0, length = objectKeyList.length; index < length; index += 1) {
        pairBuffer = "";
        if (index !== 0) pairBuffer += ", ";
        if (state.condenseFlow) pairBuffer += '"';
        objectKey = objectKeyList[index];
        objectValue = object2[objectKey];
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
    function writeBlockMapping(state, level, object2, compact) {
      var _result = "", _tag = state.tag, objectKeyList = Object.keys(object2), index, length, objectKey, objectValue, explicitPair, pairBuffer;
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
        objectValue = object2[objectKey];
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
    function detectType(state, object2, explicit) {
      var _result, typeList, index, length, type, style;
      typeList = explicit ? state.explicitTypes : state.implicitTypes;
      for (index = 0, length = typeList.length; index < length; index += 1) {
        type = typeList[index];
        if ((type.instanceOf || type.predicate) && (!type.instanceOf || typeof object2 === "object" && object2 instanceof type.instanceOf) && (!type.predicate || type.predicate(object2))) {
          state.tag = explicit ? type.tag : "?";
          if (type.represent) {
            style = state.styleMap[type.tag] || type.defaultStyle;
            if (_toString.call(type.represent) === "[object Function]") {
              _result = type.represent(object2, style);
            } else if (_hasOwnProperty.call(type.represent, style)) {
              _result = type.represent[style](object2, style);
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
    function writeNode(state, level, object2, block3, compact, iskey) {
      state.tag = null;
      state.dump = object2;
      if (!detectType(state, object2, false)) {
        detectType(state, object2, true);
      }
      var type = _toString.call(state.dump);
      if (block3) {
        block3 = state.flowLevel < 0 || state.flowLevel > level;
      }
      var objectOrArray = type === "[object Object]" || type === "[object Array]", duplicateIndex, duplicate;
      if (objectOrArray) {
        duplicateIndex = state.duplicates.indexOf(object2);
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
          if (block3 && Object.keys(state.dump).length !== 0) {
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
          if (block3 && state.dump.length !== 0) {
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
    function getDuplicateReferences(object2, state) {
      var objects = [], duplicatesIndexes = [], index, length;
      inspectNode(object2, objects, duplicatesIndexes);
      for (index = 0, length = duplicatesIndexes.length; index < length; index += 1) {
        state.duplicates.push(objects[duplicatesIndexes[index]]);
      }
      state.usedDuplicates = new Array(length);
    }
    function inspectNode(object2, objects, duplicatesIndexes) {
      var objectKeyList, index, length;
      if (object2 !== null && typeof object2 === "object") {
        index = objects.indexOf(object2);
        if (index !== -1) {
          if (duplicatesIndexes.indexOf(index) === -1) {
            duplicatesIndexes.push(index);
          }
        } else {
          objects.push(object2);
          if (Array.isArray(object2)) {
            for (index = 0, length = object2.length; index < length; index += 1) {
              inspectNode(object2[index], objects, duplicatesIndexes);
            }
          } else {
            objectKeyList = Object.keys(object2);
            for (index = 0, length = objectKeyList.length; index < length; index += 1) {
              inspectNode(object2[objectKeyList[index]], objects, duplicatesIndexes);
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml.js
var require_js_yaml = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/lib/js-yaml.js"(exports2, module2) {
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

// node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/index.js
var require_js_yaml2 = __commonJS({
  "node_modules/.pnpm/js-yaml@3.15.2/node_modules/js-yaml/index.js"(exports2, module2) {
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
      const matter7 = engine.stringify(data, options2).trim();
      let buf = "";
      if (matter7 !== "{}") {
        buf = newline(open) + newline(matter7) + newline(close);
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
    var parse19 = require_parse();
    var utils = require_utils();
    function matter7(input, options2) {
      if (input === "") {
        return { data: {}, content: input, excerpt: "", orig: input };
      }
      let file = toFile(input);
      const cached = matter7.cache[file.content];
      if (!options2) {
        if (cached) {
          file = Object.assign({}, cached);
          file.orig = cached.orig;
          return file;
        }
        matter7.cache[file.content] = file;
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
      const language = matter7.language(str2, opts);
      if (language.name) {
        file.language = language.name;
        str2 = str2.slice(language.raw.length);
      }
      let closeIndex = str2.indexOf(close);
      if (closeIndex === -1) {
        closeIndex = len;
      }
      file.matter = str2.slice(0, closeIndex);
      const block3 = file.matter.replace(/^\s*#[^\n]+/gm, "").trim();
      if (block3 === "") {
        file.isEmpty = true;
        file.empty = file.content;
        file.data = {};
      } else {
        file.data = parse19(file.language, file.matter, opts);
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
    matter7.engines = engines2;
    matter7.stringify = function(file, data, options2) {
      if (typeof file === "string") file = matter7(file, options2);
      return stringify2(file, data, options2);
    };
    matter7.read = function(filepath, options2) {
      const str2 = fs.readFileSync(filepath, "utf8");
      const file = matter7(str2, options2);
      file.path = filepath;
      return file;
    };
    matter7.test = function(str2, options2) {
      return utils.startsWith(str2, defaults(options2).delimiters[0]);
    };
    matter7.language = function(str2, options2) {
      const opts = defaults(options2);
      const open = opts.delimiters[0];
      if (matter7.test(str2)) {
        str2 = str2.slice(open.length);
      }
      const language = str2.slice(0, str2.search(/\r?\n/));
      return {
        raw: language,
        name: language ? language.trim() : ""
      };
    };
    matter7.cache = {};
    matter7.clearCache = function() {
      matter7.cache = {};
    };
    module2.exports = matter7;
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
  const { identity: identity2, capabilities, permissions, need, contributions } = assembly;
  const author = identity2.authorEmail ? { name: identity2.author, email: identity2.authorEmail } : { name: identity2.author };
  const manifest = {
    id: identity2.id,
    name: identity2.name,
    version: identity2.version,
    description: identity2.description,
    type: "frontend",
    capabilities,
    main: CONVERTED_MAIN,
    author,
    license: identity2.license,
    minAppVersion: identity2.minAppVersion,
    engines: { cognia: `>=${identity2.minAppVersion}` },
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

// node_modules/.pnpm/jsonc-parser@3.3.1/node_modules/jsonc-parser/lib/esm/impl/scanner.js
function createScanner(text, ignoreTrivia = false) {
  const len = text.length;
  let pos = 0, value = "", tokenOffset = 0, token = 16, lineNumber = 0, lineStartOffset = 0, tokenLineStartOffset = 0, prevTokenLineStartOffset = 0, scanError = 0;
  function scanHexDigits(count, exact) {
    let digits = 0;
    let value2 = 0;
    while (digits < count || !exact) {
      let ch = text.charCodeAt(pos);
      if (ch >= 48 && ch <= 57) {
        value2 = value2 * 16 + ch - 48;
      } else if (ch >= 65 && ch <= 70) {
        value2 = value2 * 16 + ch - 65 + 10;
      } else if (ch >= 97 && ch <= 102) {
        value2 = value2 * 16 + ch - 97 + 10;
      } else {
        break;
      }
      pos++;
      digits++;
    }
    if (digits < count) {
      value2 = -1;
    }
    return value2;
  }
  function setPosition(newPosition) {
    pos = newPosition;
    value = "";
    tokenOffset = 0;
    token = 16;
    scanError = 0;
  }
  function scanNumber() {
    let start = pos;
    if (text.charCodeAt(pos) === 48) {
      pos++;
    } else {
      pos++;
      while (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
      }
    }
    if (pos < text.length && text.charCodeAt(pos) === 46) {
      pos++;
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
      } else {
        scanError = 3;
        return text.substring(start, pos);
      }
    }
    let end = pos;
    if (pos < text.length && (text.charCodeAt(pos) === 69 || text.charCodeAt(pos) === 101)) {
      pos++;
      if (pos < text.length && text.charCodeAt(pos) === 43 || text.charCodeAt(pos) === 45) {
        pos++;
      }
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
        end = pos;
      } else {
        scanError = 3;
      }
    }
    return text.substring(start, end);
  }
  function scanString() {
    let result = "", start = pos;
    while (true) {
      if (pos >= len) {
        result += text.substring(start, pos);
        scanError = 2;
        break;
      }
      const ch = text.charCodeAt(pos);
      if (ch === 34) {
        result += text.substring(start, pos);
        pos++;
        break;
      }
      if (ch === 92) {
        result += text.substring(start, pos);
        pos++;
        if (pos >= len) {
          scanError = 2;
          break;
        }
        const ch2 = text.charCodeAt(pos++);
        switch (ch2) {
          case 34:
            result += '"';
            break;
          case 92:
            result += "\\";
            break;
          case 47:
            result += "/";
            break;
          case 98:
            result += "\b";
            break;
          case 102:
            result += "\f";
            break;
          case 110:
            result += "\n";
            break;
          case 114:
            result += "\r";
            break;
          case 116:
            result += "	";
            break;
          case 117:
            const ch3 = scanHexDigits(4, true);
            if (ch3 >= 0) {
              result += String.fromCharCode(ch3);
            } else {
              scanError = 4;
            }
            break;
          default:
            scanError = 5;
        }
        start = pos;
        continue;
      }
      if (ch >= 0 && ch <= 31) {
        if (isLineBreak(ch)) {
          result += text.substring(start, pos);
          scanError = 2;
          break;
        } else {
          scanError = 6;
        }
      }
      pos++;
    }
    return result;
  }
  function scanNext() {
    value = "";
    scanError = 0;
    tokenOffset = pos;
    lineStartOffset = lineNumber;
    prevTokenLineStartOffset = tokenLineStartOffset;
    if (pos >= len) {
      tokenOffset = len;
      return token = 17;
    }
    let code = text.charCodeAt(pos);
    if (isWhiteSpace(code)) {
      do {
        pos++;
        value += String.fromCharCode(code);
        code = text.charCodeAt(pos);
      } while (isWhiteSpace(code));
      return token = 15;
    }
    if (isLineBreak(code)) {
      pos++;
      value += String.fromCharCode(code);
      if (code === 13 && text.charCodeAt(pos) === 10) {
        pos++;
        value += "\n";
      }
      lineNumber++;
      tokenLineStartOffset = pos;
      return token = 14;
    }
    switch (code) {
      // tokens: []{}:,
      case 123:
        pos++;
        return token = 1;
      case 125:
        pos++;
        return token = 2;
      case 91:
        pos++;
        return token = 3;
      case 93:
        pos++;
        return token = 4;
      case 58:
        pos++;
        return token = 6;
      case 44:
        pos++;
        return token = 5;
      // strings
      case 34:
        pos++;
        value = scanString();
        return token = 10;
      // comments
      case 47:
        const start = pos - 1;
        if (text.charCodeAt(pos + 1) === 47) {
          pos += 2;
          while (pos < len) {
            if (isLineBreak(text.charCodeAt(pos))) {
              break;
            }
            pos++;
          }
          value = text.substring(start, pos);
          return token = 12;
        }
        if (text.charCodeAt(pos + 1) === 42) {
          pos += 2;
          const safeLength = len - 1;
          let commentClosed = false;
          while (pos < safeLength) {
            const ch = text.charCodeAt(pos);
            if (ch === 42 && text.charCodeAt(pos + 1) === 47) {
              pos += 2;
              commentClosed = true;
              break;
            }
            pos++;
            if (isLineBreak(ch)) {
              if (ch === 13 && text.charCodeAt(pos) === 10) {
                pos++;
              }
              lineNumber++;
              tokenLineStartOffset = pos;
            }
          }
          if (!commentClosed) {
            pos++;
            scanError = 1;
          }
          value = text.substring(start, pos);
          return token = 13;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
      // numbers
      case 45:
        value += String.fromCharCode(code);
        pos++;
        if (pos === len || !isDigit(text.charCodeAt(pos))) {
          return token = 16;
        }
      // found a minus, followed by a number so
      // we fall through to proceed with scanning
      // numbers
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
        value += scanNumber();
        return token = 11;
      // literals and unknown symbols
      default:
        while (pos < len && isUnknownContentCharacter(code)) {
          pos++;
          code = text.charCodeAt(pos);
        }
        if (tokenOffset !== pos) {
          value = text.substring(tokenOffset, pos);
          switch (value) {
            case "true":
              return token = 8;
            case "false":
              return token = 9;
            case "null":
              return token = 7;
          }
          return token = 16;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
    }
  }
  function isUnknownContentCharacter(code) {
    if (isWhiteSpace(code) || isLineBreak(code)) {
      return false;
    }
    switch (code) {
      case 125:
      case 93:
      case 123:
      case 91:
      case 34:
      case 58:
      case 44:
      case 47:
        return false;
    }
    return true;
  }
  function scanNextNonTrivia() {
    let result;
    do {
      result = scanNext();
    } while (result >= 12 && result <= 15);
    return result;
  }
  return {
    setPosition,
    getPosition: () => pos,
    scan: ignoreTrivia ? scanNextNonTrivia : scanNext,
    getToken: () => token,
    getTokenValue: () => value,
    getTokenOffset: () => tokenOffset,
    getTokenLength: () => pos - tokenOffset,
    getTokenStartLine: () => lineStartOffset,
    getTokenStartCharacter: () => tokenOffset - prevTokenLineStartOffset,
    getTokenError: () => scanError
  };
}
function isWhiteSpace(ch) {
  return ch === 32 || ch === 9;
}
function isLineBreak(ch) {
  return ch === 10 || ch === 13;
}
function isDigit(ch) {
  return ch >= 48 && ch <= 57;
}
var CharacterCodes;
(function(CharacterCodes2) {
  CharacterCodes2[CharacterCodes2["lineFeed"] = 10] = "lineFeed";
  CharacterCodes2[CharacterCodes2["carriageReturn"] = 13] = "carriageReturn";
  CharacterCodes2[CharacterCodes2["space"] = 32] = "space";
  CharacterCodes2[CharacterCodes2["_0"] = 48] = "_0";
  CharacterCodes2[CharacterCodes2["_1"] = 49] = "_1";
  CharacterCodes2[CharacterCodes2["_2"] = 50] = "_2";
  CharacterCodes2[CharacterCodes2["_3"] = 51] = "_3";
  CharacterCodes2[CharacterCodes2["_4"] = 52] = "_4";
  CharacterCodes2[CharacterCodes2["_5"] = 53] = "_5";
  CharacterCodes2[CharacterCodes2["_6"] = 54] = "_6";
  CharacterCodes2[CharacterCodes2["_7"] = 55] = "_7";
  CharacterCodes2[CharacterCodes2["_8"] = 56] = "_8";
  CharacterCodes2[CharacterCodes2["_9"] = 57] = "_9";
  CharacterCodes2[CharacterCodes2["a"] = 97] = "a";
  CharacterCodes2[CharacterCodes2["b"] = 98] = "b";
  CharacterCodes2[CharacterCodes2["c"] = 99] = "c";
  CharacterCodes2[CharacterCodes2["d"] = 100] = "d";
  CharacterCodes2[CharacterCodes2["e"] = 101] = "e";
  CharacterCodes2[CharacterCodes2["f"] = 102] = "f";
  CharacterCodes2[CharacterCodes2["g"] = 103] = "g";
  CharacterCodes2[CharacterCodes2["h"] = 104] = "h";
  CharacterCodes2[CharacterCodes2["i"] = 105] = "i";
  CharacterCodes2[CharacterCodes2["j"] = 106] = "j";
  CharacterCodes2[CharacterCodes2["k"] = 107] = "k";
  CharacterCodes2[CharacterCodes2["l"] = 108] = "l";
  CharacterCodes2[CharacterCodes2["m"] = 109] = "m";
  CharacterCodes2[CharacterCodes2["n"] = 110] = "n";
  CharacterCodes2[CharacterCodes2["o"] = 111] = "o";
  CharacterCodes2[CharacterCodes2["p"] = 112] = "p";
  CharacterCodes2[CharacterCodes2["q"] = 113] = "q";
  CharacterCodes2[CharacterCodes2["r"] = 114] = "r";
  CharacterCodes2[CharacterCodes2["s"] = 115] = "s";
  CharacterCodes2[CharacterCodes2["t"] = 116] = "t";
  CharacterCodes2[CharacterCodes2["u"] = 117] = "u";
  CharacterCodes2[CharacterCodes2["v"] = 118] = "v";
  CharacterCodes2[CharacterCodes2["w"] = 119] = "w";
  CharacterCodes2[CharacterCodes2["x"] = 120] = "x";
  CharacterCodes2[CharacterCodes2["y"] = 121] = "y";
  CharacterCodes2[CharacterCodes2["z"] = 122] = "z";
  CharacterCodes2[CharacterCodes2["A"] = 65] = "A";
  CharacterCodes2[CharacterCodes2["B"] = 66] = "B";
  CharacterCodes2[CharacterCodes2["C"] = 67] = "C";
  CharacterCodes2[CharacterCodes2["D"] = 68] = "D";
  CharacterCodes2[CharacterCodes2["E"] = 69] = "E";
  CharacterCodes2[CharacterCodes2["F"] = 70] = "F";
  CharacterCodes2[CharacterCodes2["G"] = 71] = "G";
  CharacterCodes2[CharacterCodes2["H"] = 72] = "H";
  CharacterCodes2[CharacterCodes2["I"] = 73] = "I";
  CharacterCodes2[CharacterCodes2["J"] = 74] = "J";
  CharacterCodes2[CharacterCodes2["K"] = 75] = "K";
  CharacterCodes2[CharacterCodes2["L"] = 76] = "L";
  CharacterCodes2[CharacterCodes2["M"] = 77] = "M";
  CharacterCodes2[CharacterCodes2["N"] = 78] = "N";
  CharacterCodes2[CharacterCodes2["O"] = 79] = "O";
  CharacterCodes2[CharacterCodes2["P"] = 80] = "P";
  CharacterCodes2[CharacterCodes2["Q"] = 81] = "Q";
  CharacterCodes2[CharacterCodes2["R"] = 82] = "R";
  CharacterCodes2[CharacterCodes2["S"] = 83] = "S";
  CharacterCodes2[CharacterCodes2["T"] = 84] = "T";
  CharacterCodes2[CharacterCodes2["U"] = 85] = "U";
  CharacterCodes2[CharacterCodes2["V"] = 86] = "V";
  CharacterCodes2[CharacterCodes2["W"] = 87] = "W";
  CharacterCodes2[CharacterCodes2["X"] = 88] = "X";
  CharacterCodes2[CharacterCodes2["Y"] = 89] = "Y";
  CharacterCodes2[CharacterCodes2["Z"] = 90] = "Z";
  CharacterCodes2[CharacterCodes2["asterisk"] = 42] = "asterisk";
  CharacterCodes2[CharacterCodes2["backslash"] = 92] = "backslash";
  CharacterCodes2[CharacterCodes2["closeBrace"] = 125] = "closeBrace";
  CharacterCodes2[CharacterCodes2["closeBracket"] = 93] = "closeBracket";
  CharacterCodes2[CharacterCodes2["colon"] = 58] = "colon";
  CharacterCodes2[CharacterCodes2["comma"] = 44] = "comma";
  CharacterCodes2[CharacterCodes2["dot"] = 46] = "dot";
  CharacterCodes2[CharacterCodes2["doubleQuote"] = 34] = "doubleQuote";
  CharacterCodes2[CharacterCodes2["minus"] = 45] = "minus";
  CharacterCodes2[CharacterCodes2["openBrace"] = 123] = "openBrace";
  CharacterCodes2[CharacterCodes2["openBracket"] = 91] = "openBracket";
  CharacterCodes2[CharacterCodes2["plus"] = 43] = "plus";
  CharacterCodes2[CharacterCodes2["slash"] = 47] = "slash";
  CharacterCodes2[CharacterCodes2["formFeed"] = 12] = "formFeed";
  CharacterCodes2[CharacterCodes2["tab"] = 9] = "tab";
})(CharacterCodes || (CharacterCodes = {}));

// node_modules/.pnpm/jsonc-parser@3.3.1/node_modules/jsonc-parser/lib/esm/impl/string-intern.js
var cachedSpaces = new Array(20).fill(0).map((_, index) => {
  return " ".repeat(index);
});
var maxCachedValues = 200;
var cachedBreakLinesWithSpaces = {
  " ": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\n" + " ".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + " ".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r\n" + " ".repeat(index);
    })
  },
  "	": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\n" + "	".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + "	".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r\n" + "	".repeat(index);
    })
  }
};

// node_modules/.pnpm/jsonc-parser@3.3.1/node_modules/jsonc-parser/lib/esm/impl/parser.js
var ParseOptions;
(function(ParseOptions2) {
  ParseOptions2.DEFAULT = {
    allowTrailingComma: false
  };
})(ParseOptions || (ParseOptions = {}));
function parse2(text, errors = [], options2 = ParseOptions.DEFAULT) {
  let currentProperty = null;
  let currentParent = [];
  const previousParents = [];
  function onValue(value) {
    if (Array.isArray(currentParent)) {
      currentParent.push(value);
    } else if (currentProperty !== null) {
      currentParent[currentProperty] = value;
    }
  }
  const visitor = {
    onObjectBegin: () => {
      const object2 = {};
      onValue(object2);
      previousParents.push(currentParent);
      currentParent = object2;
      currentProperty = null;
    },
    onObjectProperty: (name) => {
      currentProperty = name;
    },
    onObjectEnd: () => {
      currentParent = previousParents.pop();
    },
    onArrayBegin: () => {
      const array = [];
      onValue(array);
      previousParents.push(currentParent);
      currentParent = array;
      currentProperty = null;
    },
    onArrayEnd: () => {
      currentParent = previousParents.pop();
    },
    onLiteralValue: onValue,
    onError: (error, offset, length) => {
      errors.push({ error, offset, length });
    }
  };
  visit(text, visitor, options2);
  return currentParent[0];
}
function visit(text, visitor, options2 = ParseOptions.DEFAULT) {
  const _scanner = createScanner(text, false);
  const _jsonPath = [];
  let suppressedCallbacks = 0;
  function toNoArgVisit(visitFunction) {
    return visitFunction ? () => suppressedCallbacks === 0 && visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisit(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisitWithPath(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice()) : () => true;
  }
  function toBeginVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks++;
      } else {
        let cbReturn = visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice());
        if (cbReturn === false) {
          suppressedCallbacks = 1;
        }
      }
    } : () => true;
  }
  function toEndVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks--;
      }
      if (suppressedCallbacks === 0) {
        visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter());
      }
    } : () => true;
  }
  const onObjectBegin = toBeginVisit(visitor.onObjectBegin), onObjectProperty = toOneArgVisitWithPath(visitor.onObjectProperty), onObjectEnd = toEndVisit(visitor.onObjectEnd), onArrayBegin = toBeginVisit(visitor.onArrayBegin), onArrayEnd = toEndVisit(visitor.onArrayEnd), onLiteralValue = toOneArgVisitWithPath(visitor.onLiteralValue), onSeparator = toOneArgVisit(visitor.onSeparator), onComment = toNoArgVisit(visitor.onComment), onError = toOneArgVisit(visitor.onError);
  const disallowComments = options2 && options2.disallowComments;
  const allowTrailingComma = options2 && options2.allowTrailingComma;
  function scanNext() {
    while (true) {
      const token = _scanner.scan();
      switch (_scanner.getTokenError()) {
        case 4:
          handleError(
            14
            /* ParseErrorCode.InvalidUnicode */
          );
          break;
        case 5:
          handleError(
            15
            /* ParseErrorCode.InvalidEscapeCharacter */
          );
          break;
        case 3:
          handleError(
            13
            /* ParseErrorCode.UnexpectedEndOfNumber */
          );
          break;
        case 1:
          if (!disallowComments) {
            handleError(
              11
              /* ParseErrorCode.UnexpectedEndOfComment */
            );
          }
          break;
        case 2:
          handleError(
            12
            /* ParseErrorCode.UnexpectedEndOfString */
          );
          break;
        case 6:
          handleError(
            16
            /* ParseErrorCode.InvalidCharacter */
          );
          break;
      }
      switch (token) {
        case 12:
        case 13:
          if (disallowComments) {
            handleError(
              10
              /* ParseErrorCode.InvalidCommentToken */
            );
          } else {
            onComment();
          }
          break;
        case 16:
          handleError(
            1
            /* ParseErrorCode.InvalidSymbol */
          );
          break;
        case 15:
        case 14:
          break;
        default:
          return token;
      }
    }
  }
  function handleError(error, skipUntilAfter = [], skipUntil = []) {
    onError(error);
    if (skipUntilAfter.length + skipUntil.length > 0) {
      let token = _scanner.getToken();
      while (token !== 17) {
        if (skipUntilAfter.indexOf(token) !== -1) {
          scanNext();
          break;
        } else if (skipUntil.indexOf(token) !== -1) {
          break;
        }
        token = scanNext();
      }
    }
  }
  function parseString2(isValue) {
    const value = _scanner.getTokenValue();
    if (isValue) {
      onLiteralValue(value);
    } else {
      onObjectProperty(value);
      _jsonPath.push(value);
    }
    scanNext();
    return true;
  }
  function parseLiteral() {
    switch (_scanner.getToken()) {
      case 11:
        const tokenValue = _scanner.getTokenValue();
        let value = Number(tokenValue);
        if (isNaN(value)) {
          handleError(
            2
            /* ParseErrorCode.InvalidNumberFormat */
          );
          value = 0;
        }
        onLiteralValue(value);
        break;
      case 7:
        onLiteralValue(null);
        break;
      case 8:
        onLiteralValue(true);
        break;
      case 9:
        onLiteralValue(false);
        break;
      default:
        return false;
    }
    scanNext();
    return true;
  }
  function parseProperty() {
    if (_scanner.getToken() !== 10) {
      handleError(3, [], [
        2,
        5
        /* SyntaxKind.CommaToken */
      ]);
      return false;
    }
    parseString2(false);
    if (_scanner.getToken() === 6) {
      onSeparator(":");
      scanNext();
      if (!parseValue()) {
        handleError(4, [], [
          2,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
    } else {
      handleError(5, [], [
        2,
        5
        /* SyntaxKind.CommaToken */
      ]);
    }
    _jsonPath.pop();
    return true;
  }
  function parseObject2() {
    onObjectBegin();
    scanNext();
    let needsComma = false;
    while (_scanner.getToken() !== 2 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 2 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (!parseProperty()) {
        handleError(4, [], [
          2,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
      needsComma = true;
    }
    onObjectEnd();
    if (_scanner.getToken() !== 2) {
      handleError(7, [
        2
        /* SyntaxKind.CloseBraceToken */
      ], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseArray2() {
    onArrayBegin();
    scanNext();
    let isFirstElement = true;
    let needsComma = false;
    while (_scanner.getToken() !== 4 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 4 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (isFirstElement) {
        _jsonPath.push(0);
        isFirstElement = false;
      } else {
        _jsonPath[_jsonPath.length - 1]++;
      }
      if (!parseValue()) {
        handleError(4, [], [
          4,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
      needsComma = true;
    }
    onArrayEnd();
    if (!isFirstElement) {
      _jsonPath.pop();
    }
    if (_scanner.getToken() !== 4) {
      handleError(8, [
        4
        /* SyntaxKind.CloseBracketToken */
      ], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseValue() {
    switch (_scanner.getToken()) {
      case 3:
        return parseArray2();
      case 1:
        return parseObject2();
      case 10:
        return parseString2(true);
      default:
        return parseLiteral();
    }
  }
  scanNext();
  if (_scanner.getToken() === 17) {
    if (options2.allowEmptyContent) {
      return true;
    }
    handleError(4, [], []);
    return false;
  }
  if (!parseValue()) {
    handleError(4, [], []);
    return false;
  }
  if (_scanner.getToken() !== 17) {
    handleError(9, [], []);
  }
  return true;
}

// node_modules/.pnpm/jsonc-parser@3.3.1/node_modules/jsonc-parser/lib/esm/main.js
var ScanError;
(function(ScanError2) {
  ScanError2[ScanError2["None"] = 0] = "None";
  ScanError2[ScanError2["UnexpectedEndOfComment"] = 1] = "UnexpectedEndOfComment";
  ScanError2[ScanError2["UnexpectedEndOfString"] = 2] = "UnexpectedEndOfString";
  ScanError2[ScanError2["UnexpectedEndOfNumber"] = 3] = "UnexpectedEndOfNumber";
  ScanError2[ScanError2["InvalidUnicode"] = 4] = "InvalidUnicode";
  ScanError2[ScanError2["InvalidEscapeCharacter"] = 5] = "InvalidEscapeCharacter";
  ScanError2[ScanError2["InvalidCharacter"] = 6] = "InvalidCharacter";
})(ScanError || (ScanError = {}));
var SyntaxKind;
(function(SyntaxKind2) {
  SyntaxKind2[SyntaxKind2["OpenBraceToken"] = 1] = "OpenBraceToken";
  SyntaxKind2[SyntaxKind2["CloseBraceToken"] = 2] = "CloseBraceToken";
  SyntaxKind2[SyntaxKind2["OpenBracketToken"] = 3] = "OpenBracketToken";
  SyntaxKind2[SyntaxKind2["CloseBracketToken"] = 4] = "CloseBracketToken";
  SyntaxKind2[SyntaxKind2["CommaToken"] = 5] = "CommaToken";
  SyntaxKind2[SyntaxKind2["ColonToken"] = 6] = "ColonToken";
  SyntaxKind2[SyntaxKind2["NullKeyword"] = 7] = "NullKeyword";
  SyntaxKind2[SyntaxKind2["TrueKeyword"] = 8] = "TrueKeyword";
  SyntaxKind2[SyntaxKind2["FalseKeyword"] = 9] = "FalseKeyword";
  SyntaxKind2[SyntaxKind2["StringLiteral"] = 10] = "StringLiteral";
  SyntaxKind2[SyntaxKind2["NumericLiteral"] = 11] = "NumericLiteral";
  SyntaxKind2[SyntaxKind2["LineCommentTrivia"] = 12] = "LineCommentTrivia";
  SyntaxKind2[SyntaxKind2["BlockCommentTrivia"] = 13] = "BlockCommentTrivia";
  SyntaxKind2[SyntaxKind2["LineBreakTrivia"] = 14] = "LineBreakTrivia";
  SyntaxKind2[SyntaxKind2["Trivia"] = 15] = "Trivia";
  SyntaxKind2[SyntaxKind2["Unknown"] = 16] = "Unknown";
  SyntaxKind2[SyntaxKind2["EOF"] = 17] = "EOF";
})(SyntaxKind || (SyntaxKind = {}));
var parse3 = parse2;
var ParseErrorCode;
(function(ParseErrorCode2) {
  ParseErrorCode2[ParseErrorCode2["InvalidSymbol"] = 1] = "InvalidSymbol";
  ParseErrorCode2[ParseErrorCode2["InvalidNumberFormat"] = 2] = "InvalidNumberFormat";
  ParseErrorCode2[ParseErrorCode2["PropertyNameExpected"] = 3] = "PropertyNameExpected";
  ParseErrorCode2[ParseErrorCode2["ValueExpected"] = 4] = "ValueExpected";
  ParseErrorCode2[ParseErrorCode2["ColonExpected"] = 5] = "ColonExpected";
  ParseErrorCode2[ParseErrorCode2["CommaExpected"] = 6] = "CommaExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBraceExpected"] = 7] = "CloseBraceExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBracketExpected"] = 8] = "CloseBracketExpected";
  ParseErrorCode2[ParseErrorCode2["EndOfFileExpected"] = 9] = "EndOfFileExpected";
  ParseErrorCode2[ParseErrorCode2["InvalidCommentToken"] = 10] = "InvalidCommentToken";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfComment"] = 11] = "UnexpectedEndOfComment";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfString"] = 12] = "UnexpectedEndOfString";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfNumber"] = 13] = "UnexpectedEndOfNumber";
  ParseErrorCode2[ParseErrorCode2["InvalidUnicode"] = 14] = "InvalidUnicode";
  ParseErrorCode2[ParseErrorCode2["InvalidEscapeCharacter"] = 15] = "InvalidEscapeCharacter";
  ParseErrorCode2[ParseErrorCode2["InvalidCharacter"] = 16] = "InvalidCharacter";
})(ParseErrorCode || (ParseErrorCode = {}));
function printParseErrorCode(code) {
  switch (code) {
    case 1:
      return "InvalidSymbol";
    case 2:
      return "InvalidNumberFormat";
    case 3:
      return "PropertyNameExpected";
    case 4:
      return "ValueExpected";
    case 5:
      return "ColonExpected";
    case 6:
      return "CommaExpected";
    case 7:
      return "CloseBraceExpected";
    case 8:
      return "CloseBracketExpected";
    case 9:
      return "EndOfFileExpected";
    case 10:
      return "InvalidCommentToken";
    case 11:
      return "UnexpectedEndOfComment";
    case 12:
      return "UnexpectedEndOfString";
    case 13:
      return "UnexpectedEndOfNumber";
    case 14:
      return "InvalidUnicode";
    case 15:
      return "InvalidEscapeCharacter";
    case 16:
      return "InvalidCharacter";
  }
  return "<unknown ParseErrorCode>";
}

// lib/jsonc/index.ts
function parseJsonc(text) {
  const errors = [];
  const value = parse3(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0];
    throw new SyntaxError(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  return value;
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
function parse4(value) {
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
  parse: parse4,
  project
};

// lib/claude/agents/claude-desktop.ts
function asRoot2(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse5(value) {
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
  parse: parse5,
  project: project2
};

// lib/claude/agents/cline.ts
function asRoot3(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse6(value) {
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
  parse: parse6,
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
function parse7(value) {
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
  parse: parse7,
  project: project4
};

// lib/claude/agents/cognia.ts
function asRoot5(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse8(value) {
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
  parse: parse8,
  project: project5
};

// lib/claude/agents/cursor.ts
function asRoot6(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse9(value) {
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
  parse: parse9,
  project: project6
};

// lib/claude/agents/gemini.ts
function asRoot7(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse10(value) {
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
  parse: parse10,
  project: project7
};

// lib/claude/agents/kiro.ts
var KIRO_ONLY_KEYS = ["disabled", "autoApprove", "disabledTools"];
function asRoot8(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse11(value) {
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
  parse: parse11,
  project: project8
};

// lib/claude/agents/opencode.ts
function asRoot9(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse12(value) {
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
  parse: parse12,
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
function parse13(value) {
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
  parse: parse13,
  project: project10
};

// lib/claude/agents/roo-code.ts
function asRoot11(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse14(value) {
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
  parse: parse14,
  project: project11
};

// lib/claude/agents/vscode.ts
function asRoot12(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse15(value) {
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
  parse: parse15,
  project: project12
};

// lib/claude/agents/windsurf.ts
function asRoot13(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function parse16(value) {
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
  parse: parse16,
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
function parse17(value) {
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
  parse: parse17,
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

// node_modules/.pnpm/smol-toml@1.9.0/node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string, ptr) {
  let lines = string.slice(0, ptr).split(/\r?\n/);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string, line, column) {
  let lines = string.split(/\r?\n/);
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
var TomlError = class _TomlError extends Error {
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
  /** @internal */
  static x(message, ctx, ptr) {
    throw new _TomlError(message, { toml: ctx.s, ptr: ptr ?? ctx.p });
  }
};

// node_modules/.pnpm/smol-toml@1.9.0/node_modules/smol-toml/dist/primitive.js
function parseString(ctx) {
  let startPtr = ctx.p;
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
      TomlError.x("control characters are not allowed in strings", ctx);
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state) {
        let s = ctx.s.slice(sliceStart, ctx.p);
        parsed = parsed ? parsed + s : s;
      }
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let errPtr = ctx.p++ - 1;
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0; j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p);
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
            TomlError.x("invalid non-hex character in unicode escape", ctx);
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          TomlError.x("invalid unicode escape", ctx, errPtr);
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p--;
        state = 0;
      } else if (isMultiline && (c === 32 || c === 9)) {
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
          TomlError.x("unrecognised escape sequence", ctx);
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2)
        TomlError.x("invalid escape: only line-ending whitespace may be escaped", ctx, sliceStart);
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  TomlError.x("unfinished string", ctx, startPtr);
}

// node_modules/.pnpm/smol-toml@1.9.0/node_modules/smol-toml/dist/date.js
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[Tt ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date, fasttype, unsafeDelim) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    let c;
    if (typeof date === "string") {
      if (fasttype)
        prep: {
          if (fasttype < 3) {
            if (+date.slice(11, 13) > 23) {
              date = "";
              break prep;
            }
            if (fasttype === 2) {
              offset = null;
              date += "Z";
            } else if ((c = date.charCodeAt(date.length - 1)) !== 90 && c !== 122) {
              offset = date.slice(date.length - 6);
            }
            if (unsafeDelim)
              date = date.slice(0, 10) + "T" + date.slice(11);
          } else if (fasttype === 4) {
            date = +date.slice(0, 2) > 23 ? "" : `0000-01-01T${date}Z`;
          }
          hasDate = fasttype !== 4;
          hasTime = fasttype !== 3;
        }
      else {
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
            if (!offset && hasTime)
              date += "Z";
          }
        } else {
          date = "";
        }
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
    if (this.#offset === "Z" || this.#offset === "z")
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

// node_modules/.pnpm/smol-toml@1.9.0/node_modules/smol-toml/dist/extract.js
function isDigit2(char, base = 10) {
  return base === 16 ? char > 47 && char < 58 || char > 64 && char < 71 || char > 96 && char < 103 : char > 47 && char < 48 + base;
}
function isEndOfValue(char, delim) {
  return char === 32 || char === 9 || char === 10 || char === 13 || // Structure end or next value delimiter
  delim && (char === delim || char === 44) || // Comment
  char === 35;
}
function extractValue(ctx, end) {
  let errPtr = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p);
  if (c === 91 || c === 123) {
    ctx.d-- || TomlError.x("document contains excessively nested structures. aborting.", ctx);
    let value = c === 91 ? parseArray(ctx) : parseInlineTable(ctx);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      TomlError.x("invalid value", ctx, errPtr);
    return ctx.p++, false;
  }
  if (c === 43 || c === 45) {
    return parseNumber(ctx, ctx.p, ctx.s.charCodeAt(++ctx.p), 44 - c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 4) === 45 && ctx.s.charCodeAt(ctx.p + 7) === 45) {
    return parseDate(ctx, c, end);
  }
  if (ctx.s.charCodeAt(ctx.p + 2) === 58) {
    return parseTime(ctx, c, end);
  }
  return parseNumber(ctx, ctx.p, c, 0, end);
}
function parseNumber(ctx, startPtr, startChr, sign, endChr) {
  let c = startChr;
  let state = 0;
  let hasUnderscores = false;
  if (c === 105) {
    if (ctx.s.charCodeAt(++ctx.p) !== 110 || ctx.s.charCodeAt(++ctx.p) !== 102)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, (sign || 1) / 0;
  }
  if (c === 110) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 110)
      TomlError.x("invalid value", ctx, startPtr);
    return ctx.p++, NaN;
  }
  if (c === 48) {
    if (++ctx.p >= ctx.s.length || isEndOfValue(c = ctx.s.charCodeAt(ctx.p), endChr))
      return ctx.bi === true ? 0n : 0;
    if (!sign) {
      if (c === 120)
        return parseIntegerBaseN(ctx, startPtr, 16, endChr);
      else if (c === 98)
        return parseIntegerBaseN(ctx, startPtr, 2, endChr);
      else if (c === 111)
        return parseIntegerBaseN(ctx, startPtr, 8, endChr);
    }
    if (c === 46)
      state = 2;
    else if (c === 101 || c === 69)
      state = 4;
    else
      TomlError.x("illegal leading zero", ctx, startPtr);
  } else if (!isDigit2(c))
    TomlError.x("invalid value", ctx, startPtr);
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (!state)
      state = 1;
    if (c === 95) {
      if (!(state & 1))
        TomlError.x("illegal underscore", ctx);
      state += 11;
      hasUnderscores = true;
    } else if (state === 1 && c === 46)
      state = 2;
    else if ((state === 1 || state === 3) && (c === 101 || c === 69))
      state = 4;
    else if (state === 4 && (c === 43 || c === 45)) {
    } else if (!isDigit2(c))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (state > 9)
      state -= 11;
    else if (!(state & 1))
      state++;
  }
  if (!state) {
    let val = (startChr - 48) * (sign || 1);
    return ctx.bi === true ? BigInt(val) : val;
  }
  if (!(state & 1))
    TomlError.x("unfinished numeric value", ctx, startPtr);
  let str2 = ctx.s.slice(startPtr, ctx.p);
  if (hasUnderscores)
    str2 = str2.replaceAll("_", "");
  return state > 1 ? parseFloat(str2) : parseInteger(ctx, str2, 10, startPtr);
}
function parseIntegerBaseN(ctx, startPtr, base, endChr) {
  let c, underscore = 1;
  while (++ctx.p < ctx.s.length && (c = ctx.s.charCodeAt(ctx.p), !isEndOfValue(c, endChr))) {
    if (c === 95) {
      if (underscore & 1)
        TomlError.x("illegal underscore", ctx);
      underscore = 3;
    } else if (!isDigit2(c, base))
      TomlError.x(`illegal character in numeric literal`, ctx);
    else if (underscore & 1)
      underscore--;
  }
  if (underscore & 1)
    TomlError.x("unfinished numeric value", ctx);
  let str2 = ctx.s.slice(startPtr + 2, ctx.p);
  if (underscore)
    str2 = str2.replaceAll("_", "");
  return parseInteger(ctx, str2, base, startPtr);
}
function parseInteger(ctx, str2, base, startPtr) {
  if (ctx.bi !== true)
    int: {
      let val = parseInt(str2, base);
      if (!Number.isSafeInteger(val)) {
        if (ctx.bi)
          break int;
        TomlError.x("integer value cannot be represented losslessly", ctx, startPtr);
      }
      return val;
    }
  return base === 10 ? BigInt(str2) : BigInt((base === 2 ? "0b" : base === 8 ? "0o" : "0x") + str2);
}
function parseDate(ctx, c, endChr) {
  let startPtr = ctx.p++, unsafeSeparator;
  if (!isDigit2(c) || !isDigit2(ctx.s.charCodeAt(ctx.p++)) || !isDigit2(ctx.s.charCodeAt(ctx.p++)) || !isDigit2(ctx.s.charCodeAt(ctx.p++))) {
    return parseNumber(ctx, ctx.p = startPtr, c, 0, endChr);
  }
  ctx.p += 5;
  if (!isDigit2(ctx.s.charCodeAt(ctx.p++)))
    TomlError.x("invalid date-time: date part is malformed", ctx, startPtr);
  if (ctx.p >= ctx.s.length || ((c = ctx.s.charCodeAt(ctx.p)) !== 32 || (unsafeSeparator = true, !isDigit2(ctx.s.charCodeAt(ctx.p + 1)))) && c !== 84 && c !== 116) {
    let t2 = ctx.s.slice(startPtr, ctx.p);
    return readDate(ctx, t2, 3, false, startPtr);
  }
  if (ctx.s.charCodeAt(ctx.p += 3) !== 58)
    TomlError.x("invalid date-time: time part is malformed", ctx, startPtr);
  if (ctx.s.charCodeAt(ctx.p += 3) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit2(ctx.s.charCodeAt(++ctx.p)))
      ;
  if (c = ctx.s.charCodeAt(ctx.p)) {
    if (c === 90 || c === 122) {
      let t2 = ctx.s.slice(startPtr, ++ctx.p);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, "[+00:00]");
    }
    if (c === 43 || c === 45) {
      let t2 = ctx.s.slice(startPtr, ctx.p += 6);
      return readDate(ctx, t2, 1, unsafeSeparator, startPtr, !ctx.ld && "[" + ctx.s.slice(ctx.p - 6, ctx.p) + "]");
    }
  }
  let t = ctx.s.slice(startPtr, ctx.p);
  return readDate(ctx, t, 2, unsafeSeparator, startPtr);
}
function parseTime(ctx, c, endChr) {
  let start = ctx.p;
  if (!isDigit2(c) || !isDigit2(ctx.s.charCodeAt(++ctx.p))) {
    return parseNumber(ctx, --ctx.p, c, 0, endChr);
  }
  if (ctx.s.charCodeAt(ctx.p += 4) === 58)
    ctx.p += 3;
  if (ctx.s.charCodeAt(ctx.p) === 46)
    while (isDigit2(ctx.s.charCodeAt(++ctx.p)))
      ;
  let t = ctx.s.slice(start, ctx.p);
  return readDate(ctx, t, 4, false, start);
}
function readDate(ctx, str2, type, unsafeDelim, errPtr, temporalSuffix) {
  if (ctx.ld) {
    let date = new TomlDate(str2, type, unsafeDelim);
    if (!date.isValid())
      TomlError.x("invalid date", ctx, errPtr);
    return date;
  }
  try {
    if (temporalSuffix)
      str2 += temporalSuffix;
    switch (type) {
      case 1:
        return Temporal.ZonedDateTime.from(str2);
      case 2:
        return Temporal.PlainDateTime.from(str2);
      case 3:
        return Temporal.PlainDate.from(str2);
      case 4:
        return Temporal.PlainTime.from(str2);
    }
  } catch (e) {
    TomlError.x(e instanceof Error ? e.message : "" + e, ctx, errPtr);
  }
}

// node_modules/.pnpm/smol-toml@1.9.0/node_modules/smol-toml/dist/util.js
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
      TomlError.x("control characters are not allowed in comments", ctx);
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (ctx.p < ctx.s.length) {
    while (ctx.p < ctx.s.length && ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}

// node_modules/.pnpm/smol-toml@1.9.0/node_modules/smol-toml/dist/struct.js
function parseKey(ctx, end = 61) {
  let startPtr;
  let state = 0;
  let parsed = [];
  let sliceStart;
  let c = ctx.s.charCodeAt(startPtr = ctx.p);
  do {
    if (c === end) {
      if (!state)
        TomlError.x("unexpected end of key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      return ctx.p++, parsed;
    } else if (c === 46) {
      if (!state)
        TomlError.x("illegal empty bare key", ctx);
      if (state === 1)
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
      state = 0;
    } else if (!state && (c === 34 || c === 39)) {
      if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2))
        TomlError.x("illegal quoted key: multiline strings are not allowed", ctx);
      parsed.push(parseString(ctx));
      state = 2;
      ctx.p--;
    } else if (c === 32 || c === 9) {
      if (state === 1) {
        parsed.push(ctx.s.slice(sliceStart, ctx.p));
        state = 2;
      }
    } else if (state === 2 || c < 48 && c !== 45 || c > 57 && c < 65 || c > 90 && c < 97 && c !== 95 || c > 122) {
      TomlError.x("illegal character in key", ctx);
    } else if (!state) {
      state = 1;
      sliceStart = ctx.p;
    }
  } while (c = ctx.s.charCodeAt(++ctx.p));
  TomlError.x("incomplete key-value: cannot find end of key", ctx, startPtr);
}
function parseInlineTable(ctx) {
  let startPtr = ctx.p++;
  let res = /* @__PURE__ */ Object.create(null);
  let seen = /* @__PURE__ */ new Set();
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let errPtr = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0; i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        TomlError.x("trying to redefine an already defined value", ctx, errPtr);
      }
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor")) {
        t = ctx.uk !== 1 && TomlError.x("document contains an unsafe property", ctx, errPtr);
        break;
      }
      if (!hasOwn && unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      TomlError.x("trying to redefine an already defined value", ctx, errPtr);
    }
    skipVoid(ctx, true, true);
    let value = extractValue(
      ctx,
      125
      /* } */
    );
    if (t && typeof (t[k] = value) === "object")
      seen.add(value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished table", ctx, startPtr);
}
function parseArray(ctx) {
  let startPtr = ctx.p++;
  let res = [];
  let c;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(
      ctx,
      93
      /* ] */
    ));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44)
      TomlError.x("expected comma or end of structure", ctx, ctx.p - 1);
  }
  TomlError.x("unfinished array", ctx, startPtr);
}

// node_modules/.pnpm/smol-toml@1.9.0/node_modules/smol-toml/dist/parse.js
function peekTable(ctx, key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
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
      let unsafe = k === "__proto__";
      if (ctx.uk && (unsafe || k === "constructor"))
        return false;
      if (unsafe) {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: /* @__PURE__ */ Object.create(null)
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
    t[k].push(t = /* @__PURE__ */ Object.create(null));
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: /* @__PURE__ */ Object.create(null) };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = /* @__PURE__ */ Object.create(null);
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function validateTablePeek(ctx, peek, ptr) {
  if (peek === null || ctx.uk === 2)
    TomlError.x(peek === null ? "trying to redefine an already defined table or value" : "document contains an unsafe property", ctx, ptr);
}
function parse18(toml, options2 = {}) {
  let ctx = {
    s: toml,
    p: 0,
    d: options2.maxDepth ?? 1e3,
    bi: options2.integersAsBigInt ?? false,
    ld: options2.useLegacyDate ?? true,
    uk: options2.unsafeKeyBehaviour === "throw" ? 2 : options2.unsafeKeyBehaviour === "drop" ? 1 : 0
  };
  let res = /* @__PURE__ */ Object.create(null);
  let meta = /* @__PURE__ */ Object.create(null);
  let tmp;
  let skipping = false;
  let tbl = res;
  let m = meta;
  if (toml.charCodeAt(0) === 65279)
    ctx.p++;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      skipping = false;
      let k = parseKey(
        ctx,
        93
        /* ] */
      );
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p) !== 93) {
          TomlError.x("expected end of table array declaration", ctx);
        }
        ctx.p++;
      }
      let p = peekTable(
        ctx,
        k,
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        validateTablePeek(ctx, p, tmp);
        skipping = true;
      } else {
        m = p[2];
        tbl = p[1];
      }
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(
        ctx,
        k,
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p && !skipping)
        validateTablePeek(ctx, p, tmp);
      skipVoid(ctx, true, true);
      let v = extractValue(ctx, void 0);
      if (p && !skipping)
        p[1][p[0]] = v;
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && (tmp !== 13 || toml.charCodeAt(ctx.p + 1) !== 10)) {
      TomlError.x("each key-value declaration must be followed by an end-of-line", ctx);
    }
    skipVoid(ctx);
  }
  return res;
}

// node_modules/.pnpm/smol-toml@1.9.0/node_modules/smol-toml/dist/stringify.js
var HAS_WELLFORMED = !!"".isWellFormed;

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
      value = parse18(text);
    } catch (err) {
      throw new Error(
        `could not parse "${sourceName ?? "input"}" as TOML: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    try {
      value = parseJsonc(text);
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
  "access": "read",
  "confinedPathParams": ["path"],
  "parameters": {
    "type": "object",
    "properties": {
      "pattern": { "type": "string", "description": "Regular expression" },
      "path": { "type": "string", "description": "Search root, inside the workspace" },
      "globs": { "type": "array", "items": { "type": "string" } },
      "ignoreCase": { "type": "boolean" }
    },
    "required": ["pattern"]
  },
  "binary": { "kind": "requires", "name": "rg" },
  "argv": [
    { "literal": "--json" },
    { "literal": "--no-config" },
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

Field notes:

- \`access: "read" | "write"\` classifies the tool for the host's
  workspace-confinement gates: \`read\` hard-denies credential paths
  (\`.ssh\`, \`.aws\`, \`id_rsa\`, \u2026); \`write\` also escalates out-of-root
  targets for approval. Omit it and the tool stays opaque to confinement.
- \`confinedPathParams\` lists params whose values are filesystem paths.
  Before the consent prompt, each value must resolve inside the workspace
  root (or the plugin dir for \`cwd.kind: "plugin-dir"\`): \`..\` segments,
  absolute paths outside the base, and credential-shaped paths are rejected.
  It requires a non-\`none\` \`cwd\` kind \u2014 there must be a base to confine
  against.
- A \`{ "literal": "--no-config" }\` early in \`argv\` keeps user-level
  config files (ripgrep: \`RIPGREP_CONFIG_PATH\`) from silently changing
  behavior \u2014 or, on rg 13, re-arming the deprecated \`--pre\` hook.
- \`timeoutMs\` is the child-process cap AND sizes the resilience backstop
  and the agent-side IPC relay ceiling \u2014 a 60s tool is not severed by the
  30s/120s defaults. Its ceiling is 600000 ms, matching the
  \`plugin_cli_exec\` hard kill.
- A \`stdin\` param (\`{ "param": "name" }\`) pipes a string argument into
  the child without putting it on the command line. Secrets belong there \u2014
  the rendered argv appears in the consent prompt and the automation audit
  log, so a token passed as an argument is persisted in plaintext.
- The \`cli:execute\` consent prompt shows the rendered command line
  (program + argv + cwd), so users approve what actually runs.

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
  const path = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return Boolean(path) && !path.startsWith("/") && !/^[a-z]:/i.test(path) && !/[\x00-\x1f]/.test(path) && !path.split("/").some((part) => part === ".." || part === "." || part === "") && !/^SKILL\.md$/i.test(path);
}
var UNSUPPORTED_SKILL_EXECUTION_FIELDS = [
  "context",
  "agent",
  "model",
  "hooks",
  "user-invocable",
  "paths",
  "priority",
  "sessionStart",
  "pathPatterns",
  "bashPatterns",
  "importPatterns",
  "promptSignals",
  // OpenHands keyword triggers decide WHEN a skill activates. (Devin's
  // `triggers` user/model list is mapped by the Devin adapter, and an installed
  // Devin-origin SKILL.md keeps it as inert frontmatter.)
  "trigger"
];
function buildSkill(text, resources = [], sourceName) {
  const { draft, warnings } = parseSkillMarkdown(text, { fallbackName: sourceName });
  const id = slugify(draft.name);
  if (!id) throw new Error(`cannot derive a skill id from name "${draft.name}"`);
  const bundled = [];
  for (const resource of resources) {
    const path = resource.replace(/\\/g, "/").replace(/^\.\//, "");
    if (/^SKILL\.md$/i.test(path)) continue;
    if (!isBundleResource(path)) throw new Error(`unsafe resource path "${resource}"`);
    if (!bundled.includes(path)) bundled.push(path);
  }
  const allWarnings = [...warnings];
  const blockers = UNSUPPORTED_SKILL_EXECUTION_FIELDS.filter(
    (field) => Object.hasOwn(draft.frontmatterExtensions ?? {}, field)
  ).map(
    (field) => `Skill "${id}" requires unsupported execution field "${field}"; preserving its text does not implement its behavior.`
  );
  if (/!`[^`]+`/.test(draft.content)) {
    blockers.push(
      `Skill "${id}" requires shell preprocessing (! followed by a backtick command), which Cognia does not execute.`
    );
  }
  if (/\$(?:ARGUMENTS(?:\[\d+\])?|\d+)|\$\{(?:CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR)\}/.test(
    draft.content
  )) {
    blockers.push(
      `Skill "${id}" requires invocation argument or session substitutions which Cognia does not implement.`
    );
  }
  const metadata = {};
  for (const field of [
    "slug",
    "compatibility",
    "metadata",
    "frontmatterExtensions",
    "invocationPolicy",
    "license",
    "version",
    "author",
    "tags",
    "category"
  ]) {
    if (draft[field] !== void 0) Object.assign(metadata, { [field]: draft[field] });
  }
  if (bundled.length === 0) {
    return {
      skill: {
        ...metadata,
        id,
        name: draft.name,
        description: draft.description ?? "",
        source: { kind: "inline", markdown: draft.content },
        ...draft.allowedTools?.length ? { allowedTools: [...draft.allowedTools] } : {}
      },
      needsFilesystem: false,
      copies: [],
      warnings: allWarnings,
      blockers
    };
  }
  const bundleDir = `${SKILL_BUNDLE_DIR}/${id}`;
  return {
    skill: {
      ...metadata,
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
    warnings: allWarnings,
    blockers
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
      if (built.blockers.length > 0) throw new Error(built.blockers.join("\n"));
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
  const identity2 = resolveIdentity(
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
    identity: identity2,
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

// lib/claude/agents/agent-color.ts
var AGENT_COLOR_NAMES = [
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
  "gray"
];
var ALIASES = {
  magenta: "purple",
  violet: "purple",
  grey: "gray",
  teal: "cyan",
  amber: "orange"
};
var HEX6 = /^#([0-9a-f]{6})$/i;
var HEX3 = /^#([0-9a-f]{3})$/i;
function normalizeAgentColor(raw) {
  if (typeof raw !== "string") return void 0;
  const value = raw.trim().toLowerCase();
  if (!value) return void 0;
  if (AGENT_COLOR_NAMES.includes(value)) return value;
  const alias = ALIASES[value];
  if (alias) return alias;
  const six = HEX6.exec(value);
  if (six) return `#${six[1]}`;
  const three = HEX3.exec(value);
  if (three) {
    const [r, g, b] = three[1];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return void 0;
}

// lib/claude/agents/markdown-agents.ts
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
  if (def.color) data.color = def.color;
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
  const color = normalizeAgentColor(data.color);
  if (color) def.color = color;
  const unsupportedFields = [
    "skills",
    "memory",
    "background",
    "isolation",
    "hooks",
    "mcpServers",
    "permissionMode",
    "temperature",
    "mode",
    "permission"
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

// lib/claude/hooks/event-catalog.ts
var EVENT_META = {
  // tools
  PreToolUse: { category: "tools" },
  PostToolUse: { category: "tools" },
  PostToolBatch: { category: "tools" },
  PostToolUseFailure: { category: "tools" },
  // session
  SessionStart: { category: "session" },
  SessionEnd: { category: "session" },
  UserPromptSubmit: { category: "session" },
  UserPromptExpansion: { category: "session" },
  Stop: { category: "session" },
  StopFailure: { category: "session" },
  Notification: { category: "session" },
  MessageDisplay: { category: "session" },
  PreModelSwitch: { category: "session" },
  PostModelSwitch: { category: "session" },
  // permissions
  PermissionRequest: { category: "permissions" },
  PermissionDenied: { category: "permissions" },
  Elicitation: { category: "permissions" },
  ElicitationResult: { category: "permissions" },
  // tasks
  TaskCreated: { category: "tasks" },
  TaskCompleted: { category: "tasks" },
  SubagentStart: { category: "tasks" },
  SubagentStop: { category: "tasks" },
  TeammateIdle: { category: "tasks" },
  // lifecycle
  PreCompact: { category: "lifecycle" },
  PostCompact: { category: "lifecycle" },
  Setup: { category: "lifecycle" },
  // Producers (ADR-0111 decision 9): the managed-worktree Registry in Rust
  // (`crates/cognia-task-workspace/src/lifecycle.rs` → `src-tauri/src/
  // task_workspace.rs:HookWorktreeLifecycleSink`) and the TS git choke point
  // `lib/git/commands.ts` (`gitWorktreeAdd` / `gitWorktreeRemove`, which the
  // agent-team allocator and the source-control panel both go through).
  // Payload: `worktree_path`, `workspace_root`, `branch`, `base_ref` |
  // `base`, `owner_type`, `owner_ref`, `source`, and `reason` on remove.
  WorktreeCreate: { category: "lifecycle" },
  WorktreeRemove: { category: "lifecycle" },
  FileChanged: { category: "lifecycle" },
  DirectoryAdded: { category: "lifecycle" },
  CwdChanged: { category: "lifecycle" },
  InstructionsLoaded: { category: "lifecycle" },
  ConfigChange: { category: "lifecycle" }
};
var HOOK_EVENT_CATALOG = Object.entries(EVENT_META).map(([event, m]) => ({ event, category: m.category, dormant: m.dormant ?? false }));
var HOOK_EVENTS = HOOK_EVENT_CATALOG.map((m) => m.event);
var HOOK_EVENT_META = HOOK_EVENT_CATALOG.reduce(
  (acc, m) => {
    acc[m.event] = m;
    return acc;
  },
  {}
);
var HOOK_EVENT_SET = new Set(HOOK_EVENTS);

// lib/claude/hooks.ts
var DORMANT_HOOK_HANDLER_FIELDS = [
  "args",
  "if",
  "statusMessage",
  "once",
  "asyncRewake",
  "shell",
  "allowedEnvVars"
];

// lib/plugin/convert/delivery.ts
var PLUGIN_ECOSYSTEMS = [
  "cognia",
  "claude-code",
  "codex",
  "gemini-cli",
  "agent-plugins",
  "cursor",
  "copilot",
  "kimi",
  "devin",
  "opencode",
  "pi",
  "factory-droid",
  "qoder",
  "codebuddy",
  "auggie",
  "open-plugins"
];
var HOSTED_TOOL_CAPABILITIES = /* @__PURE__ */ new Set(["tools", "cli-tools"]);
var HOSTED_SESSION_TARGETS = /* @__PURE__ */ new Set([
  "claude-code",
  "codex",
  "gemini-cli",
  "devin",
  "opencode",
  "pi"
]);
function assessPluginDelivery({
  manifest,
  report,
  target,
  surface = "cli"
}) {
  const capabilities = [...new Set(manifest?.capabilities ?? [])];
  const hostedTools = capabilities.filter((capability) => HOSTED_TOOL_CAPABILITIES.has(capability));
  const hostedStatus = target === "cognia" || hostedTools.length === 0 ? "unavailable" : surface === "cloud" || !HOSTED_SESSION_TARGETS.has(target) ? "unverified" : "requires-cognia";
  const aliases = {
    agents: "subagent",
    hooks: "command-hooks",
    commandHooks: "command-hooks",
    mcpServers: "mcp-server-preset",
    mcp: "mcp-server-preset",
    // A complete Pi package is one contribution: themes, extensions and the
    // package manifest are retained by it, never converted on their own.
    piPackages: "pi-package"
  };
  const canonicalCapability = (value) => value.startsWith("skill-") ? "skills" : aliases[value] ?? value;
  const listed = [
    .../* @__PURE__ */ new Set([
      ...capabilities,
      ...[...report.converted, ...report.warnings, ...report.blocking].map(
        (issue2) => canonicalCapability(issue2.capability)
      )
    ])
  ];
  const details = listed.map(
    (capability) => {
      const blocked2 = report.blocking.some(
        (issue2) => canonicalCapability(issue2.capability) === capability
      );
      const warning = report.warnings.some(
        (issue2) => canonicalCapability(issue2.capability) === capability
      );
      const converted = report.converted.some(
        (issue2) => canonicalCapability(issue2.capability) === capability
      );
      const status = blocked2 ? hostedStatus === "requires-cognia" && HOSTED_TOOL_CAPABILITIES.has(capability) ? "hosted" : "unsupported" : capability === "mcp-server-preset" && manifest?.mcpServerPresets?.some((preset) => preset.fields?.length) ? "configuration-required" : warning ? report.fidelity === "contextual" ? "contextual" : "unverified" : report.blocking.length && !converted ? "unverified" : "native";
      return { capability, status };
    }
  );
  return {
    target,
    surface,
    native: report.blocking.length ? "blocked" : report.warnings.length || report.fidelity === "contextual" ? "review-required" : "ready",
    hostVerified: false,
    capabilities: details,
    hosted: {
      status: hostedStatus,
      capabilities: hostedTools,
      // A Pi package is delivered natively to Pi; everywhere else it stays in
      // Cognia (installed into Pi or loaded into Cognia-hosted Pi sessions).
      retained: capabilities.filter(
        (capability) => !HOSTED_TOOL_CAPABILITIES.has(capability) && !(capability === "pi-package" && target === "pi")
      )
    }
  };
}

// lib/plugin/convert/source-snapshot.ts
function isPluginEnvironmentFile(relativePath) {
  return /(^|\/)\.env(?:\.|$)/.test(relativePath);
}
var GENERATED_FILE_PATHS = ["plugin.json", "dist/index.js"];
var NEUTRALIZED_CONTENTS = ["{}\n", "\n"];
function isOverlayEntryAllowed(snapshot, path, contents) {
  return GENERATED_FILE_PATHS.includes(path) || snapshot.has(path) && NEUTRALIZED_CONTENTS.includes(contents);
}

// lib/plugin/convert/platform-bundles.ts
var import_gray_matter4 = __toESM(require_gray_matter());

// lib/plugin/convert/hook-dialects.ts
var CLAUDE_HANDLERS = ["command", "http", "prompt", "agent", "mcp_tool"];
function identity(events) {
  return Object.fromEntries(events.map((event) => [event, event]));
}
var HOOK_DIALECTS = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    events: identity(HOOK_EVENTS),
    shape: "groups",
    handlerTypes: CLAUDE_HANDLERS,
    timeoutUnit: "seconds",
    claudeToolNames: true,
    claudeContract: true
  },
  codex: {
    id: "codex",
    label: "Codex",
    // `Interrupt` has no Cognia hook event and stays blocking.
    events: identity([
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Stop"
    ]),
    shape: "groups",
    // Codex parses `prompt` / `agent` handlers but skips them: converting one
    // would activate behavior that never ran in the source host.
    handlerTypes: ["command", "mcp_tool"],
    timeoutUnit: "seconds",
    claudeToolNames: true,
    claudeContract: true
  },
  "gemini-cli": {
    id: "gemini-cli",
    label: "Gemini CLI",
    events: {
      BeforeTool: "PreToolUse",
      AfterTool: "PostToolUse",
      SessionStart: "SessionStart",
      SessionEnd: "SessionEnd",
      Notification: "Notification",
      PreCompress: "PreCompact"
    },
    shape: "groups",
    handlerTypes: ["command"],
    timeoutUnit: "milliseconds",
    claudeToolNames: false,
    claudeContract: false,
    // `sequential: true` serializes a group; Cognia runs a group's handlers
    // with Claude semantics, so only the default converts.
    groupFlags: { sequential: false },
    presentationFields: ["name", "description"]
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    events: {
      sessionStart: "SessionStart",
      sessionEnd: "SessionEnd",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      postToolUseFailure: "PostToolUseFailure",
      subagentStart: "SubagentStart",
      subagentStop: "SubagentStop",
      beforeSubmitPrompt: "UserPromptSubmit",
      preCompact: "PreCompact",
      stop: "Stop"
    },
    shape: "flat",
    handlerTypes: ["command"],
    timeoutUnit: "seconds",
    claudeToolNames: false,
    claudeContract: false,
    version: 1
  },
  "factory-droid": {
    id: "factory-droid",
    label: "Factory Droid",
    events: identity([
      "PreToolUse",
      "PostToolUse",
      "Notification",
      "UserPromptSubmit",
      "Stop",
      "SubagentStop",
      "PreCompact",
      "SessionStart",
      "SessionEnd"
    ]),
    shape: "groups",
    handlerTypes: ["command"],
    timeoutUnit: "seconds",
    claudeToolNames: false,
    claudeContract: true
  },
  qoder: {
    id: "qoder",
    label: "Qoder CLI",
    events: identity([
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionRequest",
      "PermissionDenied",
      "Stop",
      "StopFailure",
      "SubagentStart",
      "SubagentStop",
      "PreCompact",
      "PostCompact",
      "Notification",
      "InstructionsLoaded",
      "ConfigChange",
      "CwdChanged",
      "FileChanged",
      "WorktreeCreate",
      "WorktreeRemove",
      "Elicitation",
      "ElicitationResult"
    ]),
    shape: "groups",
    handlerTypes: ["command", "http", "prompt", "agent"],
    timeoutUnit: "seconds",
    claudeToolNames: true,
    claudeContract: true
  },
  codebuddy: {
    id: "codebuddy",
    label: "CodeBuddy",
    events: identity([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PermissionDenied",
      "PostToolUse",
      "PostToolUseFailure",
      "Notification",
      "SubagentStart",
      "SubagentStop",
      "TaskCreated",
      "TaskCompleted",
      "Stop",
      "StopFailure",
      "TeammateIdle",
      "InstructionsLoaded",
      "ConfigChange",
      "CwdChanged",
      "FileChanged",
      "WorktreeCreate",
      "WorktreeRemove",
      "PreCompact",
      "PostCompact",
      "Elicitation",
      "ElicitationResult",
      "SessionEnd"
    ]),
    shape: "groups",
    handlerTypes: ["command", "prompt"],
    promptEvents: ["Stop", "UserPromptSubmit", "PreToolUse"],
    timeoutUnit: "seconds",
    claudeToolNames: true,
    claudeContract: true
  },
  auggie: {
    id: "auggie",
    label: "Auggie",
    events: identity(["PreToolUse", "PostToolUse", "Stop", "SessionStart", "SessionEnd"]),
    shape: "groups",
    handlerTypes: ["command"],
    timeoutUnit: "milliseconds",
    claudeToolNames: false,
    claudeContract: false,
    commandRule: {
      pattern: /^\s*"?[^\s"]+\.(?:sh|ps1|cmd|bat)"?(?:\s|$)/i,
      message: "Auggie runs hook script files only (.sh, .ps1, .cmd, .bat); an inline shell command has no Auggie equivalent"
    }
  },
  openhands: {
    id: "openhands",
    label: "OpenHands",
    events: identity([
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "Stop",
      "SessionStart",
      "SessionEnd"
    ]),
    shape: "groups",
    handlerTypes: ["command"],
    timeoutUnit: "seconds",
    claudeToolNames: false,
    claudeContract: false
  }
};
var WILDCARD_MATCHERS = /* @__PURE__ */ new Set(["", "*", ".*", "**"]);
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function block(sink, path, message) {
  sink.blocking.push({ capability: "commandHooks", path, message, blocking: true });
}
function warn(sink, path, message) {
  if (sink.warnings.some((issue2) => issue2.path === path && issue2.message === message)) return;
  sink.warnings.push({ capability: "commandHooks", path, message, blocking: false });
}
function contractWarning(dialect) {
  if (dialect.claudeContract && dialect.claudeToolNames) return void 0;
  return dialect.claudeContract ? `${dialect.label} reports its own tool names in hook payloads; exit-code blocking is shared, but scripts that inspect tool_name/tool_input must be verified` : `${dialect.label} hook payload fields and JSON decision output differ from Claude's contract; exit code 2 blocking is shared, but scripts that parse stdin or print decisions must be verified`;
}
function convertTimeout(value, from, to) {
  if (typeof value !== "number" || from === to) return value;
  return from === "milliseconds" ? value / 1e3 : Math.round(value * 1e3);
}
function hookDocumentToCanonical(args) {
  const { value, path, dialect, sink } = args;
  if (dialect.id === "claude-code") return value;
  const wrapped = isRecord(value.hooks);
  const eventMap = wrapped ? value.hooks : value;
  if (wrapped) {
    for (const key of Object.keys(value)) {
      if (key === "hooks" || key === "description") continue;
      if (key === "version" && dialect.version !== void 0 && value.version === dialect.version)
        continue;
      block(sink, path, `${dialect.label} hook file field "${key}" has no Cognia equivalent`);
    }
  }
  const canonical = {};
  let converted = 0;
  for (const [hostEvent, entries] of Object.entries(eventMap)) {
    const event = dialect.events[hostEvent];
    if (!event) {
      block(
        sink,
        path,
        `${dialect.label} hook event "${hostEvent}" has no exact Cognia hook-runtime equivalent`
      );
      continue;
    }
    if (!Array.isArray(entries)) {
      block(sink, path, `hook event "${hostEvent}" must map to an array`);
      continue;
    }
    const groups = [];
    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry)) {
        block(sink, path, `hook entry "${hostEvent}"[${index}] must be an object`);
        continue;
      }
      const group = dialect.shape === "flat" ? (() => {
        const { matcher: matcher2, ...handler } = entry;
        return { ...matcher2 !== void 0 ? { matcher: matcher2 } : {}, hooks: [handler] };
      })() : { ...entry };
      for (const [flag, accepted] of Object.entries(dialect.groupFlags ?? {})) {
        if (!(flag in group)) continue;
        if (group[flag] !== accepted) {
          block(
            sink,
            path,
            `${dialect.label} hook group "${hostEvent}"[${index}] sets ${flag}=${JSON.stringify(group[flag])}, which Cognia cannot reproduce`
          );
        }
        delete group[flag];
      }
      const matcher = group.matcher;
      if (matcher !== void 0 && !dialect.claudeToolNames && !(typeof matcher === "string" && WILDCARD_MATCHERS.has(matcher.trim()))) {
        block(
          sink,
          path,
          `${dialect.label} matcher ${JSON.stringify(matcher)} on "${hostEvent}" selects the host's own tool or event vocabulary; it cannot be mapped to Cognia's`
        );
        continue;
      }
      if (matcher !== void 0 && !dialect.claudeToolNames) delete group.matcher;
      const handlers = group.hooks;
      if (Array.isArray(handlers)) {
        ;
        group.hooks = handlers.map((raw, handlerIndex) => {
          if (!isRecord(raw)) return raw;
          const handler = { ...raw };
          if (handler.type === void 0 && dialect.shape === "flat") handler.type = "command";
          const type = handler.type;
          if (typeof type === "string" && !dialect.handlerTypes.includes(type)) {
            block(
              sink,
              path,
              `${dialect.label} hook handler "${hostEvent}"[${index}].hooks[${handlerIndex}] of type "${type}" is not executed by ${dialect.label} or has no exact Cognia equivalent`
            );
          }
          if (type === "prompt" && dialect.promptEvents && !dialect.promptEvents.includes(event)) {
            block(
              sink,
              path,
              `${dialect.label} only runs prompt hooks on ${dialect.promptEvents.join(", ")}`
            );
          }
          for (const field of dialect.presentationFields ?? []) {
            if (handler[field] === void 0) continue;
            warn(
              sink,
              path,
              `${dialect.label} hook ${field} labels the hook in the host UI only and was not projected`
            );
            delete handler[field];
          }
          if (handler.timeout !== void 0)
            handler.timeout = convertTimeout(handler.timeout, dialect.timeoutUnit, "seconds");
          return handler;
        });
      }
      groups.push(group);
    }
    if (groups.length) {
      canonical[event] = [...canonical[event] ?? [], ...groups];
      converted += groups.length;
    }
  }
  const message = contractWarning(dialect);
  if (message && converted > 0) warn(sink, path, message);
  return { hooks: canonical };
}
function canonicalHooksToDialect(args) {
  const { hooks, dialect, sink, path } = args;
  const reverse = /* @__PURE__ */ new Map();
  for (const [hostEvent, canonical] of Object.entries(dialect.events)) {
    if (!reverse.has(canonical)) reverse.set(canonical, hostEvent);
  }
  const output2 = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!groups?.length) continue;
    const hostEvent = reverse.get(event);
    if (!hostEvent) {
      block(
        sink,
        `commandHooks.${event}`,
        `${dialect.label} has no hook event equivalent to ${event}`
      );
      continue;
    }
    const entries = [];
    for (const [index, group] of groups.entries()) {
      const location = `commandHooks.${event}[${index}]`;
      if (group.agents) {
        block(sink, location, `${dialect.label} cannot enforce Cognia agent selectors`);
        continue;
      }
      const matcher = group.matcher;
      const wildcard = matcher === void 0 || WILDCARD_MATCHERS.has(matcher.trim());
      if (!wildcard && !dialect.claudeToolNames) {
        block(
          sink,
          location,
          `${dialect.label} matches ${JSON.stringify(matcher)} against its own tool vocabulary; the matcher cannot be carried across`
        );
        continue;
      }
      const handlers = [];
      for (const handler of group.hooks) {
        if (!dialect.handlerTypes.includes(handler.type)) {
          block(sink, location, `${dialect.label} does not execute "${handler.type}" hook handlers`);
          continue;
        }
        if (handler.type === "prompt" && dialect.promptEvents && !dialect.promptEvents.includes(event)) {
          block(
            sink,
            location,
            `${dialect.label} only runs prompt hooks on ${dialect.promptEvents.join(", ")}`
          );
          continue;
        }
        if ("policyClass" in handler && handler.policyClass === "managed") {
          block(sink, location, "Managed fail-closed hook policies require the Cognia host");
          continue;
        }
        if (handler.type === "command" && dialect.commandRule && !dialect.commandRule.pattern.test(handler.command)) {
          block(sink, location, dialect.commandRule.message);
          continue;
        }
        const projected = { ...handler };
        delete projected.policyClass;
        if (projected.timeout !== void 0)
          projected.timeout = convertTimeout(projected.timeout, "seconds", dialect.timeoutUnit);
        handlers.push(projected);
      }
      if (!handlers.length) continue;
      if (dialect.shape === "flat") {
        for (const handler of handlers) {
          const { type, ...rest } = handler;
          entries.push({
            ...type === "command" ? {} : { type },
            ...rest,
            ...matcher !== void 0 && !wildcard ? { matcher } : {}
          });
        }
      } else {
        entries.push({
          ...matcher !== void 0 && (dialect.claudeToolNames || !wildcard) ? { matcher } : {},
          hooks: handlers
        });
      }
    }
    if (entries.length) output2[hostEvent] = entries;
  }
  if (!Object.keys(output2).length) return void 0;
  const message = contractWarning(dialect);
  if (message) warn(sink, path, message);
  return dialect.version !== void 0 ? { version: dialect.version, hooks: output2 } : { hooks: output2 };
}

// lib/plugin/convert/claude-family.ts
var import_gray_matter3 = __toESM(require_gray_matter());
var METADATA = [
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords"
];
var markdownAgentId = (path) => {
  const match = /^([^/]+)\.md$/i.exec(path);
  return match ? match[1] : null;
};
var CLAUDE_BLOCKED = {
  lspServers: "LSP servers need a language-server host; Cognia has no plugin LSP contribution",
  outputStyles: "Output styles replace the host's response style; Cognia has no equivalent",
  workflows: "Plugin workflows (workflows/*.js) are executable host code",
  settings: "Plugin settings (agent, subagentStatusLine) change the host session; Cognia has no equivalent",
  userConfig: "userConfig prompts for values substituted as ${user_config.KEY}; no exact Cognia projection exists yet",
  channels: "Channels inject messages from external services into the session",
  dependencies: "Plugin dependencies install other plugins from a marketplace",
  experimental: "Experimental themes, monitors and evals have no Cognia equivalent",
  types: "Type declarations configure host-specific component typing"
};
var CLAUDE_PATHS = [
  { path: "monitors/", capability: "monitors", message: "Background monitors run host code" },
  { path: "themes/", capability: "themes", message: "Themes restyle the host UI" },
  { path: "workflows/", capability: "workflows", message: "Workflows are executable host code" },
  {
    path: "output-styles/",
    capability: "outputStyles",
    message: "Output styles replace the host's response style"
  },
  {
    path: "settings.json",
    capability: "settings",
    message: "Root settings.json changes host defaults"
  },
  {
    path: ".lsp.json",
    capability: "lspServers",
    message: "LSP servers need a language-server host"
  },
  {
    path: "bin/",
    capability: "bin",
    message: "Claude Code adds bin/ to the Bash PATH; Cognia does not, so bare-name invocations of these executables fail \u2014 reference them through the plugin root",
    warn: true
  }
];
var SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var CLAUDE_FAMILY_PROFILES = {
  "claude-code": {
    ecosystem: "claude-code",
    label: "Claude Code",
    manifestPaths: [".claude-plugin/plugin.json"],
    exportManifestPath: ".claude-plugin/plugin.json",
    metadataFields: [...METADATA, "displayName", "icon"],
    componentFields: ["skills", "commands", "agents", "hooks", "mcpServers"],
    ignoredFields: {
      $schema: "Schema reference only",
      metadata: "Marketplace metadata is not projected into Cognia",
      defaultEnabled: "Cognia enables imported plugins through its own install flow; the default is not projected",
      documentationUrl: "Directory presentation only",
      supportUrl: "Directory presentation only",
      privacyPolicyUrl: "Directory presentation only",
      termsOfServiceUrl: "Directory presentation only"
    },
    blockedFields: CLAUDE_BLOCKED,
    // Claude Code strips unknown top-level keys with a warning, so they carry no behavior.
    unknownFields: "warn",
    blockedPaths: CLAUDE_PATHS,
    agentsDir: "agents",
    agentId: markdownAgentId,
    agentFields: null,
    commandsDir: "commands",
    mcpFile: ".mcp.json",
    mcpMode: "merge",
    skillsMode: "additive",
    hookFiles: ["hooks/hooks.json", "hooks.json"],
    hooksMode: "merge",
    hookDialect: HOOK_DIALECTS["claude-code"],
    rootTokens: ["${CLAUDE_PLUGIN_ROOT}"],
    rootEnvVars: ["CLAUDE_PLUGIN_ROOT"],
    dataTokens: ["${CLAUDE_PLUGIN_DATA}"],
    claudeRootAlias: true,
    requireDotSlashPaths: true,
    nameRule: {
      pattern: /^[^\s@:/\\\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/u,
      message: "Claude Code plugin names cannot contain spaces, @, :, path separators, control or bidi characters"
    },
    exportComponentPaths: true,
    reservedNames: {
      pattern: /^(?:claude-|anthropic-|anthropics-|cc-plugin-)|^claude-code$/,
      message: "Claude Code reserves the claude-, anthropic-, anthropics- and cc-plugin- name prefixes"
    }
  },
  "factory-droid": {
    ecosystem: "factory-droid",
    label: "Factory Droid",
    manifestPaths: [".factory-plugin/plugin.json"],
    exportManifestPath: ".factory-plugin/plugin.json",
    metadataFields: METADATA,
    componentFields: [],
    // Droid neither requires nor reads plugin.json; identity comes from the
    // marketplace entry and components are discovered by convention only.
    ignoredFields: {
      skills: "Droid discovers skills/ by convention and does not read manifest paths",
      commands: "Droid discovers commands/ by convention and does not read manifest paths",
      agents: "Droid discovers droids/ by convention and does not read manifest paths",
      hooks: "Droid reads hooks/hooks.json by convention and does not read manifest hooks",
      mcpServers: "Droid reads mcp.json by convention and does not read manifest MCP",
      outputStyles: "Droid discovers output-styles/ by convention"
    },
    blockedFields: {},
    unknownFields: "warn",
    blockedPaths: [
      {
        path: "output-styles/",
        capability: "outputStyles",
        message: "Droid output styles replace the response style; Cognia has no equivalent"
      }
    ],
    agentsDir: "droids",
    agentId: markdownAgentId,
    agentFields: ["name", "description"],
    agentDefaults: { model: "inherit" },
    commandsDir: "commands",
    mcpFile: "mcp.json",
    mcpMode: "replace",
    skillsMode: "replace",
    hookFiles: ["hooks/hooks.json"],
    hooksMode: "replace",
    hookDialect: HOOK_DIALECTS["factory-droid"],
    rootTokens: ["${DROID_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}"],
    rootEnvVars: ["DROID_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"],
    dataTokens: [],
    claudeRootAlias: true,
    requireDotSlashPaths: false,
    nameRule: { pattern: /^\S+$/, message: "Droid plugin names cannot contain whitespace" },
    exportComponentPaths: false
  },
  qoder: {
    ecosystem: "qoder",
    label: "Qoder CLI",
    manifestPaths: [".qoder-plugin/plugin.json"],
    exportManifestPath: ".qoder-plugin/plugin.json",
    metadataFields: METADATA,
    componentFields: ["skills", "commands", "agents", "hooks"],
    ignoredFields: {},
    blockedFields: {
      outputStyles: "Output styles replace the host's response style; Cognia has no equivalent"
    },
    unknownFields: "block",
    blockedPaths: [
      {
        path: "output-styles/",
        capability: "outputStyles",
        message: "Output styles replace the host's response style"
      },
      {
        path: "bin/",
        capability: "bin",
        message: "Qoder adds bin/ executables to the session; Cognia does not"
      }
    ],
    agentsDir: "agents",
    agentId: markdownAgentId,
    agentFields: ["name", "description"],
    commandsDir: "commands",
    mcpFile: ".mcp.json",
    mcpMode: "replace",
    skillsMode: "replace",
    hookFiles: ["hooks/hooks.json"],
    hooksMode: "replace",
    hookDialect: HOOK_DIALECTS.qoder,
    rootTokens: ["${QODER_PLUGIN_ROOT}"],
    rootEnvVars: ["QODER_PLUGIN_ROOT"],
    dataTokens: ["${QODER_PLUGIN_DATA}"],
    claudeRootAlias: false,
    requireDotSlashPaths: false,
    nameRule: { pattern: /^\S+$/, message: "Qoder plugin names cannot contain spaces" },
    exportComponentPaths: false
  },
  codebuddy: {
    ecosystem: "codebuddy",
    label: "CodeBuddy",
    manifestPaths: [".codebuddy-plugin/plugin.json", ".workbuddy-plugin/plugin.json"],
    exportManifestPath: ".codebuddy-plugin/plugin.json",
    metadataFields: METADATA,
    componentFields: ["skills", "commands", "agents", "hooks", "mcpServers"],
    ignoredFields: {
      defaultEnabled: "Cognia enables imported plugins through its own install flow; the default is not projected"
    },
    blockedFields: {
      outputStyles: CLAUDE_BLOCKED.outputStyles,
      lspServers: CLAUDE_BLOCKED.lspServers,
      dependencies: CLAUDE_BLOCKED.dependencies,
      userConfig: CLAUDE_BLOCKED.userConfig,
      channels: CLAUDE_BLOCKED.channels,
      experimental: CLAUDE_BLOCKED.experimental
    },
    unknownFields: "block",
    blockedPaths: [
      CLAUDE_PATHS[3],
      {
        path: ".lsp.json",
        capability: "lspServers",
        message: "LSP servers need a language-server host"
      }
    ],
    agentsDir: "agents",
    agentId: markdownAgentId,
    agentFields: ["name", "description", "effort", "maxTurns"],
    commandsDir: "commands",
    mcpFile: ".mcp.json",
    mcpMode: "merge",
    skillsMode: "replace",
    hookFiles: ["hooks/hooks.json"],
    hooksMode: "merge",
    hookDialect: HOOK_DIALECTS.codebuddy,
    rootTokens: ["${CODEBUDDY_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}"],
    rootEnvVars: ["CODEBUDDY_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"],
    dataTokens: ["${CODEBUDDY_PLUGIN_DATA}", "${CLAUDE_PLUGIN_DATA}"],
    claudeRootAlias: true,
    requireDotSlashPaths: false,
    nameRule: { pattern: SLUG, message: "CodeBuddy plugin names must be kebab-case" },
    exportComponentPaths: false
  },
  auggie: {
    ecosystem: "auggie",
    label: "Auggie",
    manifestPaths: [".augment-plugin/plugin.json"],
    exportManifestPath: ".augment-plugin/plugin.json",
    metadataFields: METADATA,
    componentFields: ["skills", "commands", "agents", "hooks", "mcpServers"],
    ignoredFields: {},
    blockedFields: {},
    unknownFields: "block",
    blockedPaths: [
      {
        path: "rules/",
        capability: "rules",
        message: "Auggie rules are always-on instructions; Cognia plugins have no rule contribution"
      }
    ],
    agentsDir: "agents",
    agentId: markdownAgentId,
    agentFields: ["name", "description", "color"],
    commandsDir: "commands",
    mcpFile: ".mcp.json",
    mcpMode: "ambiguous",
    skillsMode: "ambiguous",
    hookFiles: ["hooks/hooks.json"],
    hooksMode: "ambiguous",
    hookDialect: HOOK_DIALECTS.auggie,
    rootTokens: ["${AUGMENT_PLUGIN_ROOT}", "${AUGGIE_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}"],
    rootEnvVars: ["AUGMENT_PLUGIN_ROOT", "AUGGIE_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"],
    dataTokens: [],
    claudeRootAlias: true,
    requireDotSlashPaths: false,
    nameRule: { pattern: /^\S+$/, message: "Auggie plugin names cannot contain whitespace" },
    exportComponentPaths: false
  },
  "open-plugins": {
    ecosystem: "open-plugins",
    label: "Open Plugins (legacy .plugin)",
    manifestPaths: [".plugin/plugin.json", ".goose-plugin/plugin.json"],
    exportManifestPath: ".plugin/plugin.json",
    metadataFields: METADATA,
    componentFields: [],
    ignoredFields: {},
    blockedFields: {
      skills: "Legacy OpenPlugin hosts (Copilot, OpenHands, Goose) disagree on manifest path overrides",
      commands: "Legacy OpenPlugin hosts (Copilot, OpenHands, Goose) disagree on manifest path overrides",
      agents: "Legacy OpenPlugin hosts (Copilot, OpenHands, Goose) disagree on manifest path overrides",
      hooks: "Legacy OpenPlugin hosts (Copilot, OpenHands, Goose) disagree on manifest path overrides",
      mcpServers: "Legacy OpenPlugin hosts (Copilot, OpenHands, Goose) disagree on manifest path overrides"
    },
    unknownFields: "block",
    blockedPaths: [],
    agentsDir: "agents",
    agentId: (path) => {
      const match = /^([^/]+?)(?:\.agent)?\.md$/i.exec(path);
      return match ? match[1] : null;
    },
    agentFields: ["name", "description"],
    commandsDir: "commands",
    mcpFile: ".mcp.json",
    mcpMode: "replace",
    skillsMode: "replace",
    hookFiles: ["hooks/hooks.json"],
    hooksMode: "replace",
    hookDialect: HOOK_DIALECTS.openhands,
    rootTokens: ["${PLUGIN_ROOT}"],
    rootEnvVars: ["PLUGIN_ROOT"],
    dataTokens: ["${PLUGIN_DATA}"],
    claudeRootAlias: false,
    requireDotSlashPaths: false,
    nameRule: { pattern: /^\S+$/, message: "Plugin names cannot contain whitespace" },
    exportComponentPaths: false
  }
};
function claudeFamilyManifestPath(files, profile) {
  return profile.manifestPaths.find((path) => files.has(path));
}
function replaceRootTokens(value, tokens, envVars, replacement) {
  if (typeof value === "string") {
    let result = value;
    for (const token of tokens) result = result.replaceAll(token, replacement);
    for (const name of envVars)
      result = result.replace(new RegExp(`\\$${name}(?![A-Za-z0-9_])`, "g"), replacement);
    return result;
  }
  if (Array.isArray(value))
    return value.map((entry) => replaceRootTokens(entry, tokens, envVars, replacement));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceRootTokens(entry, tokens, envVars, replacement)
      ])
    );
  return value;
}
var CLAUDE_MANIFEST = ".claude-plugin/plugin.json";
function projectClaudeFamilyBundle(input, profile) {
  const result = { files: new Map(input), blocking: [], warnings: [] };
  if (profile.ecosystem === "claude-code") return result;
  const fail = (capability, path, message) => result.blocking.push({ capability, path, message, blocking: true });
  const exportToken = profile.rootTokens[0];
  const swap = (value) => replaceRootTokens(value, ["${CLAUDE_PLUGIN_ROOT}"], ["CLAUDE_PLUGIN_ROOT"], exportToken);
  const manifestText = input.get(CLAUDE_MANIFEST);
  if (manifestText === void 0) {
    fail("format", CLAUDE_MANIFEST, "A validated Claude bundle manifest is required");
    return result;
  }
  const source = JSON.parse(manifestText);
  result.files.delete(CLAUDE_MANIFEST);
  const manifest = {};
  for (const key of METADATA) if (source[key] !== void 0) manifest[key] = source[key];
  if (typeof manifest.name === "string" && !profile.nameRule.pattern.test(manifest.name))
    fail("name", `${profile.exportManifestPath}.name`, profile.nameRule.message);
  for (const [path, text] of Array.from(result.files)) {
    if (!path.startsWith("agents/") || !path.endsWith(".md")) continue;
    result.files.delete(path);
    const id = path.slice("agents/".length, -".md".length);
    let parsed;
    try {
      parsed = (0, import_gray_matter3.default)(text);
    } catch (error) {
      fail("subagent", path, error instanceof Error ? error.message : String(error));
      continue;
    }
    const allowed = new Set(profile.agentFields ?? []);
    const unsupported = Object.keys(parsed.data).filter((key) => !allowed.has(key));
    if (unsupported.length) {
      fail(
        "subagent",
        `subagents.${id}`,
        `${profile.label} agents have no exact equivalent for: ${unsupported.join(", ")}`
      );
      continue;
    }
    const target = profile.ecosystem === "open-plugins" ? null : `${profile.agentsDir}/${id}.md`;
    if (!target) {
      fail(
        "subagent",
        `subagents.${id}`,
        "Legacy OpenPlugin hosts disagree on agent files (Copilot *.agent.md, OpenHands <name>.md); export to agent-plugins or copilot instead"
      );
      continue;
    }
    result.files.set(target, text);
  }
  const mcpText = result.files.get(".mcp.json");
  if (mcpText !== void 0) {
    result.files.delete(".mcp.json");
    const document = JSON.parse(mcpText);
    const servers = document.mcpServers ?? {};
    if (profile.ecosystem === "open-plugins") {
      for (const [name, server] of Object.entries(servers)) {
        if (JSON.stringify(server).includes("${CLAUDE_PLUGIN_ROOT}") || server.cwd !== void 0)
          fail(
            "mcp",
            `mcpServers.${name}`,
            "Legacy OpenPlugin hosts do not document plugin-root expansion or cwd for MCP servers; use a PATH command or a remote server"
          );
      }
    }
    result.files.set(profile.mcpFile, `${JSON.stringify(swap(document), null, 2)}
`);
  }
  const hooksText = result.files.get("hooks/hooks.json");
  if (hooksText !== void 0) {
    result.files.delete("hooks/hooks.json");
    const document = JSON.parse(hooksText);
    const projected = canonicalHooksToDialect({
      hooks: document.hooks ?? {},
      dialect: profile.hookDialect,
      sink: result,
      path: "hooks/hooks.json"
    });
    if (projected)
      result.files.set("hooks/hooks.json", `${JSON.stringify(swap(projected), null, 2)}
`);
  }
  if (!profile.claudeRootAlias) {
    for (const [path, text] of result.files) {
      if (path === "hooks/hooks.json" || path === profile.mcpFile) continue;
      if (text.includes("${CLAUDE_PLUGIN_ROOT}"))
        fail(
          "resources",
          path,
          `${profile.label} does not expand \${CLAUDE_PLUGIN_ROOT} in bundled resources; update the reference before exporting`
        );
    }
  }
  if (profile.exportComponentPaths) {
    for (const key of profile.componentFields)
      if (source[key] !== void 0) manifest[key] = source[key];
  }
  result.files.set(profile.exportManifestPath, `${JSON.stringify(manifest, null, 2)}
`);
  result.warnings.push({
    capability: "compatibility",
    path: profile.exportManifestPath,
    message: `Native ${profile.label} installation and execution require separate verification`,
    blocking: false
  });
  return result;
}

// lib/plugin/convert/bundle-detection.ts
var VENDOR_MANIFEST_PATHS = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".devin-plugin/plugin.json",
  ".factory-plugin/plugin.json",
  ".qoder-plugin/plugin.json",
  ".codebuddy-plugin/plugin.json",
  ".workbuddy-plugin/plugin.json",
  ".augment-plugin/plugin.json",
  ".goose-plugin/plugin.json",
  ".plugin/plugin.json",
  ".github/plugin/plugin.json",
  "gemini-extension.json"
];
var VENDOR_DIRECTORY_MARKERS = [
  [".devin-plugin/plugin.json", "devin"],
  [".factory-plugin/plugin.json", "factory-droid"],
  [".qoder-plugin/plugin.json", "qoder"],
  [".codebuddy-plugin/plugin.json", "codebuddy"],
  [".workbuddy-plugin/plugin.json", "codebuddy"],
  [".augment-plugin/plugin.json", "auggie"],
  [".cursor-plugin/plugin.json", "cursor"],
  [".codex-plugin/plugin.json", "codex"],
  [".github/plugin/plugin.json", "copilot"],
  [".goose-plugin/plugin.json", "open-plugins"],
  ["gemini-extension.json", "gemini-cli"],
  ["opencode.json", "opencode"],
  ["opencode.jsonc", "opencode"]
];
var GENERIC_MARKERS = [
  [".plugin/plugin.json", "open-plugins"],
  [".claude-plugin/plugin.json", "claude-code"]
];
var AGENT_PLUGINS_SCHEMA_PREFIX = "https://agent-plugins.org/schemas/";
var KIMI_KEYS = ["tools", "inject", "config_file"];
function parseObject(text) {
  if (text === void 0) return void 0;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
function neutralized(text) {
  return text !== void 0 && /^\s*\{\s*\}\s*$/.test(text);
}
function classifyRootManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `could not parse plugin.json: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("plugin.json must contain a JSON object");
  const root = parsed;
  if (typeof root.id === "string" && typeof root.type === "string")
    return { ecosystem: "cognia", tier: 0 };
  if (typeof root.$schema === "string") {
    if (root.$schema.startsWith(AGENT_PLUGINS_SCHEMA_PREFIX))
      return { ecosystem: "agent-plugins", tier: 2 };
    throw new Error("plugin.json schema is not a recognized Cognia or Agent Plugins format");
  }
  if (KIMI_KEYS.some((key) => key in root)) return { ecosystem: "kimi", tier: 1 };
  if (typeof root.id === "string") return { ecosystem: "cognia", tier: 3 };
  return { ecosystem: "copilot", tier: 1 };
}
function isPiPackage(text) {
  const pkg = parseObject(text);
  if (!pkg) return false;
  return pkg.pi !== null && typeof pkg.pi === "object" && !Array.isArray(pkg.pi) || Array.isArray(pkg.keywords) && pkg.keywords.includes("pi-package");
}
function detectPluginBundle(files) {
  const candidates = [];
  const rootText = files.get("plugin.json");
  if (rootText !== void 0 && !neutralized(rootText)) {
    const root = classifyRootManifest(rootText);
    if (root.ecosystem === "cognia" && root.tier === 0)
      return { ecosystem: "cognia", manifestPath: "plugin.json", shadowed: [] };
    candidates.push({ path: "plugin.json", ...root });
  }
  for (const [path, ecosystem] of VENDOR_DIRECTORY_MARKERS)
    if (files.has(path)) candidates.push({ path, ecosystem, tier: 1 });
  if (isPiPackage(files.get("package.json")))
    candidates.push({ path: "package.json", ecosystem: "pi", tier: 1 });
  for (const [path, ecosystem] of GENERIC_MARKERS)
    if (files.has(path)) candidates.push({ path, ecosystem, tier: 2 });
  const active = candidates.filter((candidate) => !neutralized(files.get(candidate.path)));
  const pool = active.length ? active : candidates;
  if (pool.length === 0) {
    if (rootText !== void 0)
      return { ecosystem: "cognia", manifestPath: "plugin.json", shadowed: [] };
    throw new Error(
      "plugin format not recognized \u2014 provide a Cognia, Agent Plugins, Claude Code, Codex, Gemini, Cursor, Copilot, Kimi, Devin, OpenCode, Pi, Factory Droid, Qoder, CodeBuddy, Auggie or Open Plugins bundle"
    );
  }
  const bestTier = Math.min(...pool.map((candidate) => candidate.tier));
  const winners = pool.filter((candidate) => candidate.tier === bestTier);
  const ecosystems = [...new Set(winners.map((candidate) => candidate.ecosystem))];
  if (bestTier < 2 && ecosystems.length > 1)
    throw new Error(
      `multiple plugin formats found (${winners.map((candidate) => candidate.path).join(", ")}); provide one unambiguous plugin bundle`
    );
  const ordered = bestTier === 2 ? [
    ...winners.filter((candidate) => candidate.ecosystem === "agent-plugins"),
    ...winners.filter((candidate) => candidate.path === ".plugin/plugin.json"),
    ...winners.filter((candidate) => candidate.path === ".claude-plugin/plugin.json")
  ] : winners;
  const selected = ordered[0];
  const resolved = selected.ecosystem;
  return {
    ecosystem: resolved,
    manifestPath: selected.path,
    shadowed: active.filter((candidate) => candidate.path !== selected.path).map(({ path, ecosystem: shadowedEcosystem }) => ({ path, ecosystem: shadowedEcosystem }))
  };
}

// lib/plugin/convert/platform-bundles.ts
var AGENT_PLUGINS_SCHEMA_VERSIONS = ["1.0.0", "1.1.0"];
var AP_PLUGIN_SCHEMA = (version) => `https://agent-plugins.org/schemas/${version}/plugin.schema.json`;
var AP_MCP_SCHEMA = (version) => `https://agent-plugins.org/schemas/${version}/mcp.schema.json`;
var AGENT_PLUGINS_SCHEMA = AP_PLUGIN_SCHEMA("1.0.0");
var CLAUDE_MANIFEST2 = ".claude-plugin/plugin.json";
var NORMALIZED = ".cognia-normalized";
var METADATA2 = [
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords"
];
var AP_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
var PLATFORM_BUNDLE_PROFILES = {
  "agent-plugins": {
    manifest: "plugin.json",
    surfaces: ["cli", "desktop"],
    skills: "native",
    mcp: "native",
    agents: "client-namespace",
    hooks: "client-namespace"
  },
  cursor: {
    manifest: ".cursor-plugin/plugin.json",
    surfaces: ["desktop"],
    skills: "native",
    mcp: "native",
    agents: "native",
    hooks: "event-map"
  },
  copilot: {
    manifest: "plugin.json",
    surfaces: ["cli", "desktop", "cloud"],
    skills: "native",
    mcp: "native",
    agents: "client-namespace",
    hooks: "host-contract"
  },
  kimi: {
    manifest: "plugin.json",
    surfaces: ["cli"],
    skills: "root-skill-only",
    mcp: "unsupported",
    agents: "unsupported",
    hooks: "unsupported"
  },
  devin: {
    manifest: ".devin-plugin/plugin.json",
    surfaces: ["cli", "desktop", "cloud"],
    skills: "native",
    mcp: "native",
    agents: "local-only",
    hooks: "local-fail-open"
  },
  opencode: {
    manifest: "opencode.json",
    surfaces: ["cli"],
    skills: "native",
    mcp: "native",
    agents: "subagent-mode-only",
    hooks: "runtime-port-required"
  }
};
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function read(files, path) {
  const text = files.get(path) ?? "{}";
  const value = path.endsWith(".jsonc") ? parseJsonc(text) : JSON.parse(text);
  if (!object(value)) throw new Error(`${path} must contain an object`);
  return value;
}
function present(value) {
  return value !== void 0 && value !== null && value !== false && value !== "" && (!Array.isArray(value) || value.length > 0) && (!object(value) || Object.keys(value).length > 0);
}
function block2(result, capability, path, message) {
  result.blocking.push({ capability, path, message, blocking: true });
}
function warn2(result, capability, path, message) {
  result.warnings.push({ capability, path, message, blocking: false });
}
function save(files, path, value) {
  files.set(path, `${JSON.stringify(value, null, 2)}
`);
}
function emptyProjection(files) {
  return { files: new Map(files), blocking: [], warnings: [], transient: /* @__PURE__ */ new Set() };
}
function stripDot(path) {
  return path.replace(/^\.\//, "").replace(/\/+$/, "");
}
function pathsOf(value) {
  return (typeof value === "string" ? [value] : Array.isArray(value) ? value : []).filter((entry) => typeof entry === "string").map(stripDot);
}
function manifestPath(files, target) {
  if (target === "copilot") {
    if (files.has("plugin.json")) return "plugin.json";
    return ".github/plugin/plugin.json";
  }
  if (target === "opencode" && !files.has("opencode.json")) return "opencode.jsonc";
  return PLATFORM_BUNDLE_PROFILES[target].manifest;
}
var UNMAPPED_SURFACES = {
  "agent-plugins": [
    [
      /^(?:agents|commands|hooks|rules|prompts|extensions|themes|output-styles)\//,
      "platform-control",
      "Agent Plugins hosts do not load root-level agents, commands, hooks or rules; client-specific components belong in a reverse-domain namespace directory"
    ],
    [
      /^(?:hooks|lsp|\.lsp|\.app)\.json$/,
      "platform-control",
      "Agent Plugins defines no portable hooks, LSP or app files"
    ],
    [
      /^(?:AGENTS|CLAUDE|GEMINI)\.md$/,
      "rules",
      "Always-on instruction files are not part of an Agent Plugins bundle"
    ]
  ],
  copilot: [
    [
      /^(?:hooks\.json|hooks\/hooks\.json)$/,
      "hooks",
      "Copilot hook files use Copilot's own contract (version 1, flat bash/powershell entries, preToolUse fail-closed on non-zero exit); no exact Cognia mapping exists"
    ],
    [
      /^(?:lsp|\.lsp)\.json$|^\.github\/lsp\.json$|^lsp-config\//,
      "lspServers",
      "LSP servers need a language-server host; Cognia has no plugin LSP contribution"
    ],
    [
      /^(?:rules|extensions|prompts|themes|output-styles)\//,
      "platform-control",
      "Copilot rules and extensions have no Cognia equivalent"
    ],
    [
      /^(?:AGENTS|CLAUDE|GEMINI)\.md$/,
      "rules",
      "Always-on instruction files have no Cognia plugin equivalent"
    ]
  ],
  cursor: [
    [
      /^rules\//,
      "rules",
      "Cursor rules apply as persistent context (alwaysApply / globs); a Cognia skill only loads on demand, so the guidance would stop applying automatically"
    ],
    [
      /^(?:policies|extensions|prompts|themes|output-styles)\//,
      "platform-control",
      "No Cognia equivalent for this Cursor surface"
    ],
    [
      /^(?:AGENTS|CLAUDE|GEMINI)\.md$/,
      "rules",
      "Always-on instruction files have no Cognia plugin equivalent"
    ]
  ],
  // Kimi reads plugin.json and a root SKILL.md only: every other file is an
  // inert resource of that skill, so nothing else needs a mapping.
  kimi: [],
  devin: [
    [
      /^AGENTS\.md$/,
      "rules",
      "Devin injects AGENTS.md as an always-on rule in every session; Cognia plugins have no always-on rule contribution"
    ],
    [
      /^rules\//,
      "rules",
      "Devin rules load by trigger frontmatter; Cognia plugins have no rule contribution"
    ],
    [
      /^agents\//,
      "agents",
      "Devin plugin subagents load only in local Devin agents; their routing has no verified Cognia equivalent"
    ],
    [
      /^(?:hooks\.json|hooks\/)/,
      "hooks",
      "Devin plugin hooks run best-effort and fail open in local sessions only; Cognia would run them on every surface"
    ],
    [
      /^(?:commands|policies|extensions|prompts|themes|output-styles)\//,
      "platform-control",
      "No Cognia equivalent for this Devin surface"
    ],
    [
      /^(?:lsp|\.lsp|\.app)\.json$/,
      "platform-control",
      "No Cognia equivalent for this Devin surface"
    ]
  ],
  opencode: [
    [
      /^\.opencode\/(?:modes?|plugins?|tools?|themes?)\//,
      "platform-control",
      "OpenCode modes, JS/TS plugins, custom tools and themes are executable or host-UI configuration; use Cognia hosting or a manual port"
    ],
    [
      /^(?:agents?|commands?|hooks|rules|policies|extensions|prompts|themes|output-styles|plugins?)\//,
      "platform-control",
      "OpenCode reads these directories from .opencode/ only"
    ],
    [
      /^(?:AGENTS|CLAUDE)\.md$/,
      "rules",
      "Always-on instruction files have no Cognia plugin equivalent"
    ]
  ]
};
var FOREIGN_SURFACES = [
  [
    /^\.opencode\/(?:agents?|commands?|modes?|plugins?|tools?|themes?)\//,
    "platform-control",
    "OpenCode runtime configuration has no meaning for this host"
  ]
];
var allowedNamespaces = {
  "agent-plugins": ["dev.openhands", "com.github.copilot"],
  copilot: ["com.github.copilot"]
};
function inventory(files, result, target, consumed = /* @__PURE__ */ new Set()) {
  for (const path of files.keys()) {
    if (path.startsWith("/") || path.split(/[\\/]/).includes("..") || path.includes("\\")) {
      block2(result, "path", path, "Bundle paths must be relative canonical paths without traversal");
      continue;
    }
    if (consumed.has(path) || path.startsWith(`${NORMALIZED}/`)) continue;
    const surfaces = [
      ...UNMAPPED_SURFACES[target],
      ...target === "opencode" ? [] : FOREIGN_SURFACES
    ];
    let reported = false;
    for (const [pattern, capability, message] of surfaces) {
      if (pattern.test(path)) {
        block2(result, capability, path, message);
        reported = true;
        break;
      }
    }
    if (!reported && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//.test(path)) {
      const namespace = path.split("/")[0];
      if (!(allowedNamespaces[target] ?? []).includes(namespace))
        block2(
          result,
          "platform-control",
          path,
          `Client namespace ${namespace}/ has no documented Cognia mapping for this host`
        );
    }
  }
}
function checkFields(source, allowed, path, result) {
  for (const field of Object.keys(source)) {
    if (!allowed.includes(field))
      block2(result, field, `${path}.${field}`, "Field has no verified behavioral mapping");
  }
}
function validateApManifest(source, path, result) {
  if (typeof source.name !== "string" || source.name.length > 64 || !AP_NAME.test(source.name))
    block2(result, "name", `${path}.name`, "Name is invalid for the Agent Plugins manifest");
  for (const key of ["version", "description", "homepage", "repository", "license"]) {
    if (source[key] !== void 0 && typeof source[key] !== "string")
      block2(result, "metadata", `${path}.${key}`, "Portable manifest metadata must be a string");
  }
  if (source.keywords !== void 0 && (!Array.isArray(source.keywords) || source.keywords.some((keyword) => typeof keyword !== "string")))
    block2(result, "metadata", `${path}.keywords`, "Portable keywords must be an array of strings");
  if (source.author !== void 0) {
    if (!object(source.author))
      block2(result, "metadata", `${path}.author`, "Portable author must be an object");
    else {
      checkFields(source.author, ["name", "email", "url"], `${path}.author`, result);
      if (Object.values(source.author).some((value) => typeof value !== "string"))
        block2(result, "metadata", `${path}.author`, "Portable author values must be strings");
    }
  }
  if (source.extensions !== void 0 && (!object(source.extensions) || Object.values(source.extensions).some((value) => !object(value))))
    block2(
      result,
      "extensions",
      `${path}.extensions`,
      "Portable extensions must map namespaces to objects"
    );
}
function apVersion(source) {
  return AGENT_PLUGINS_SCHEMA_VERSIONS.find(
    (version) => source.$schema === AP_PLUGIN_SCHEMA(version)
  );
}
function adaptSkillSemantics(files, result, target, direction, skillPaths = [...files.keys()].filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"))) {
  const known = [
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "disable-model-invocation",
    "allowed-tools",
    "allowedTools"
  ];
  for (const path of skillPaths) {
    try {
      const text = result.files.get(path) ?? files.get(path);
      const parsed = (0, import_gray_matter4.default)(text);
      const data = { ...parsed.data };
      let changed = false;
      if (direction === "import" && target === "kimi") {
        for (const alias of ["disableModelInvocation", "disable_model_invocation"]) {
          if (data[alias] === void 0) continue;
          if (data["disable-model-invocation"] !== void 0 && data["disable-model-invocation"] !== data[alias]) {
            block2(result, "skill-invocation", path, "Conflicting Kimi invocation policy aliases");
          }
          data["disable-model-invocation"] = data[alias];
          delete data[alias];
          changed = true;
        }
        if (data.type === "prompt" || data.type === "inline") {
          delete data.type;
          changed = true;
        }
      }
      if (direction === "import" && target === "devin") {
        if (data.triggers !== void 0) {
          const triggers = data.triggers;
          if (Array.isArray(triggers) && triggers.includes("user") && triggers.every((entry) => entry === "user" || entry === "model")) {
            data["disable-model-invocation"] = !triggers.includes("model");
            delete data.triggers;
            changed = true;
          } else
            block2(
              result,
              "skill-invocation",
              path,
              "Devin model-only or custom triggers need an invocation adapter"
            );
        }
        if (data["argument-hint"] !== void 0) {
          warn2(
            result,
            "skill-frontmatter",
            `${path}.argument-hint`,
            "argument-hint only labels the skill in the host UI and was not projected"
          );
          delete data["argument-hint"];
          changed = true;
        }
      }
      for (const key of Object.keys(data)) {
        if (!known.includes(key))
          block2(
            result,
            "skill-frontmatter",
            `${path}.${key}`,
            "Skill field has no verified cross-platform behavioral mapping"
          );
      }
      if (present(data["allowed-tools"]) || present(data.allowedTools)) {
        block2(
          result,
          "skill-tools",
          path,
          "Tool identities and pre-approval differ by host; a tool and permission adapter is required"
        );
      }
      const manual = data["disable-model-invocation"];
      if (manual !== void 0 && typeof manual !== "boolean")
        block2(result, "skill-invocation", path, "disable-model-invocation must be a boolean");
      if (manual === true && (target === "opencode" || target === "agent-plugins")) {
        block2(
          result,
          "skill-invocation",
          path,
          target === "opencode" ? "OpenCode ignores disable-model-invocation; manual-only activation cannot be preserved" : "Agent Plugins does not define a host-independent manual invocation policy"
        );
      }
      if (direction === "export" && target === "devin" && typeof manual === "boolean") {
        data.triggers = manual ? ["user"] : ["user", "model"];
        delete data["disable-model-invocation"];
        changed = true;
      }
      const directoryName = path.split("/").at(-2);
      if (direction === "import" && target === "opencode" && directoryName && data.name !== directoryName)
        block2(result, "skill-name", path, "OpenCode skill names must match their directory");
      if (direction === "export") {
        if (typeof data.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) || data.name.length > 64)
          block2(
            result,
            "skill-name",
            path,
            "Target skills require a lowercase identifier of at most 64 characters"
          );
        if (target !== "pi" && target !== "devin" && target !== "kimi" && directoryName && data.name !== directoryName)
          block2(result, "skill-name", path, "Target skill name must match its parent directory");
        if (typeof data.description !== "string" || !data.description.trim() || data.description.length > 1024)
          block2(
            result,
            "skill-description",
            path,
            "Target skills require a non-empty description of at most 1024 characters"
          );
      }
      if (changed) result.files.set(path, import_gray_matter4.default.stringify(parsed.content, data));
    } catch (error) {
      block2(
        result,
        "skill-frontmatter",
        path,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  const roots = skillPaths.map((path) => path.slice(0, Math.max(0, path.lastIndexOf("/"))));
  const runtime = /\$(?:\{(?:COGNIA_PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|CLAUDE_SKILL_DIR|CODEX_PLUGIN_ROOT|COPILOT_PLUGIN_ROOT|PLUGIN_ROOT|PLUGIN_DATA|CURSOR_PLUGIN_ROOT|KIMI_PLUGIN_ROOT|KIMI_SKILL_DIR|extensionPath|workspacePath)\}|(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|PLUGIN_DATA|KIMI_SKILL_DIR)\b)/;
  for (const [path, text] of files) {
    const resource = roots.some(
      (root) => root ? path.startsWith(`${root}/`) : path === "SKILL.md" || /^(?:scripts|references|assets)\//.test(path)
    );
    if (resource && runtime.test(text))
      block2(
        result,
        "skill-runtime",
        path,
        "Host runtime variables in skill resources need a component-specific binding; bytes were preserved but execution cannot be promised"
      );
    if (direction === "export" && target === "opencode" && path.startsWith("skills/")) {
      const outsideSkillTree = [...text.matchAll(/(?:\.\.\/)+/g)].some(
        (match) => match[0].split("../").length - 1 >= path.split("/").length - 1
      );
      if (outsideSkillTree)
        block2(
          result,
          "skill-resources",
          path,
          "Moving skills into .opencode changes relative references outside the skills tree; dependency relocation is required"
        );
    }
  }
}
function checkSkillSemantics(files, target, direction, skillPaths) {
  const result = emptyProjection(files);
  adaptSkillSemantics(files, result, target, direction, skillPaths);
  return result;
}
function mcpServers(documents, target, result, version) {
  const output2 = {};
  for (const document of documents) {
    if (target === "agent-plugins") {
      checkFields(document.value, ["$schema", "mcpServers"], document.path, result);
      if (!version || document.value.$schema !== AP_MCP_SCHEMA(version))
        block2(
          result,
          "schema",
          `${document.path}.$schema`,
          "mcp.json must declare the Agent Plugins MCP schema of the same version as plugin.json"
        );
    } else if (target !== "opencode")
      checkFields(document.value, ["$schema", "mcpServers"], document.path, result);
    const servers = target === "opencode" ? document.value.mcp ?? {} : document.value.mcpServers ?? {};
    if (!object(servers)) throw new Error(`${document.path} servers must be an object`);
    for (const [name, value] of Object.entries(servers)) {
      if (!object(value)) throw new Error(`MCP server ${name} must be an object`);
      let server = { ...value };
      const location = `${document.path}.${name}`;
      if (target === "opencode") {
        const converted = openCodeServer(name, server, location, result);
        if (!converted) continue;
        server = converted;
      }
      const type = server.type ?? (server.command ? "stdio" : "http");
      if (target === "agent-plugins" && !["stdio", "streamable-http", "sse"].includes(String(server.type))) {
        block2(result, "mcp", `mcpServers.${name}.type`, "Portable MCP transport must be explicit");
      }
      checkFields(
        server,
        type === "stdio" ? ["type", "command", "args", "env", "cwd"] : ["type", "url", "headers"],
        `mcpServers.${name}`,
        result
      );
      if (type === "stdio") {
        if (typeof server.command !== "string" || !server.command.trim())
          throw new Error(`MCP server ${name} requires a command`);
        if (server.args !== void 0 && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string")))
          throw new Error(`MCP server ${name} args must be strings`);
      } else if (!["http", "streamable-http", "sse"].includes(String(type)) || typeof server.url !== "string" || !server.url.trim()) {
        throw new Error(`Unsupported MCP transport or URL: ${name}`);
      }
      for (const key of ["env", "headers"]) {
        const record = server[key];
        if (record !== void 0 && (!object(record) || Object.values(record).some((item) => typeof item !== "string")))
          throw new Error(`MCP server ${name} ${key} must contain strings`);
      }
      const serialized = JSON.stringify(server);
      if (/\$\{(?:[A-Z]+_)?PLUGIN_DATA\}/.test(serialized))
        block2(
          result,
          "runtime-data",
          `mcpServers.${name}`,
          "Persistent plugin data lifecycle needs a verified binding"
        );
      if (target === "agent-plugins" || target === "copilot") {
        if (typeof server.command === "string" && server.command.includes("${"))
          block2(
            result,
            "mcp",
            `mcpServers.${name}.command`,
            "Agent Plugins never expands variables in command; use a bare name or a ./-relative path"
          );
        if (type !== "stdio" && serialized.includes("${PLUGIN_ROOT}"))
          block2(
            result,
            "mcp",
            `mcpServers.${name}`,
            "Agent Plugins passes remote server values through literally; ${PLUGIN_ROOT} would not expand there"
          );
        if (typeof server.command === "string" && server.command.startsWith("./"))
          server.command = `\${PLUGIN_ROOT}/${server.command.slice(2)}`;
        if (type === "stdio" && server.cwd === void 0 && target === "agent-plugins")
          server.cwd = "${PLUGIN_ROOT}";
        if (server.cwd !== void 0) {
          if (typeof server.cwd !== "string" || !/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/.test(server.cwd))
            block2(
              result,
              "mcp",
              `mcpServers.${name}.cwd`,
              "Agent Plugins cwd must start with ./, ${PLUGIN_ROOT} or ${PLUGIN_DATA}"
            );
          else if (server.cwd.startsWith("./"))
            server.cwd = `\${PLUGIN_ROOT}/${server.cwd.slice(2)}`;
        }
        if (object(server.env) && ["PLUGIN_ROOT", "PLUGIN_DATA"].some((key) => key in server.env))
          block2(
            result,
            "mcp",
            `mcpServers.${name}.env`,
            "Portable MCP reserved runtime variables cannot be overridden"
          );
      }
      if (target === "cursor" && /\$\{PLUGIN_(?:ROOT|DATA)\}/.test(serialized))
        block2(
          result,
          "mcp",
          `mcpServers.${name}`,
          "Cursor does not expand ${PLUGIN_ROOT} or ${PLUGIN_DATA}; the server would receive the literal text"
        );
      const tokens = target === "cursor" ? ["${CURSOR_PLUGIN_ROOT}"] : target === "copilot" ? ["${PLUGIN_ROOT}", "${COPILOT_PLUGIN_ROOT}"] : target === "devin" ? ["${PLUGIN_ROOT}"] : target === "agent-plugins" ? ["${PLUGIN_ROOT}"] : [];
      server = replaceRootTokens(server, tokens, [], "${CLAUDE_PLUGIN_ROOT}");
      if (output2[name] !== void 0)
        block2(result, "mcp", location, "Duplicate MCP server name across declarations");
      output2[name] = { ...server, type: type === "streamable-http" ? "http" : type };
    }
  }
  return output2;
}
function openCodeServer(name, server, location, result) {
  const allowed = server.type === "remote" ? ["type", "url", "enabled", "headers", "oauth", "timeout"] : ["type", "command", "cwd", "environment", "enabled", "timeout"];
  checkFields(server, allowed, `mcp.${name}`, result);
  if (server.enabled === false)
    block2(result, "mcp", `mcp.${name}.enabled`, "Disabled-server state cannot be discarded");
  if (server.timeout !== void 0 && server.timeout !== 5e3)
    warn2(
      result,
      "mcp",
      `mcp.${name}.timeout`,
      "OpenCode's tool-fetch timeout is not projected; Cognia applies its own MCP startup timeout"
    );
  const text = JSON.stringify(server);
  if (/\{file:[^}]+\}/.test(text)) {
    block2(
      result,
      "mcp",
      location,
      "OpenCode {file:path} substitution reads files at load time; Cognia has no equivalent"
    );
    return null;
  }
  const substitute = (value) => typeof value === "string" ? value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}") : value;
  if (server.type === "remote") {
    block2(
      result,
      "mcp",
      location,
      "OpenCode remote servers fall back from streamable HTTP to SSE and negotiate OAuth automatically; Cognia cannot reproduce that negotiation"
    );
    return null;
  }
  if (server.type !== "local" || !Array.isArray(server.command) || server.command.length === 0)
    throw new Error(`Invalid OpenCode MCP server: ${name}`);
  if (typeof server.cwd === "string" && !server.cwd.startsWith("/"))
    warn2(
      result,
      "mcp",
      `mcp.${name}.cwd`,
      "OpenCode resolves a relative cwd from the project directory; verify the working directory after import"
    );
  const environment = object(server.environment) ? Object.fromEntries(
    Object.entries(server.environment).map(([key, value]) => [key, substitute(value)])
  ) : void 0;
  return {
    command: substitute(server.command[0]),
    args: server.command.slice(1).map(substitute),
    ...environment ? { env: environment } : {},
    ...typeof server.cwd === "string" ? { cwd: server.cwd } : {}
  };
}
function mcpDeclarations(files, declared, conventional, mode, result) {
  const documents = [];
  const items = Array.isArray(declared) ? declared : declared === void 0 ? [] : [declared];
  for (const item of items) {
    if (typeof item === "string") {
      const path = stripDot(item);
      if (!files.has(path)) throw new Error(`MCP configuration not found: ${path}`);
      documents.push({ path, value: read(files, path) });
    } else if (object(item)) {
      documents.push({
        path: "mcpServers",
        value: "mcpServers" in item ? item : { mcpServers: item }
      });
    } else {
      block2(
        result,
        "mcp",
        "mcpServers",
        "This MCP declaration shape is not documented for the host"
      );
    }
  }
  if (documents.length === 0 || mode === "merge") {
    for (const path of conventional)
      if (files.has(path) && !documents.some((document) => document.path === path))
        documents.push({ path, value: read(files, path) });
  }
  return documents;
}
function normalizeAgent(args) {
  const { path, result } = args;
  let parsed;
  try {
    parsed = (0, import_gray_matter4.default)(args.files.get(path) ?? "");
  } catch (error) {
    block2(result, "agents", path, error instanceof Error ? error.message : String(error));
    return;
  }
  const data = { ...parsed.data };
  const veto = args.rewrite?.(data);
  if (veto) {
    block2(result, "agents", path, veto);
    return;
  }
  const unsupported = Object.keys(data).filter((key) => !args.allowed.includes(key));
  if (unsupported.length) {
    block2(
      result,
      "agents",
      path,
      `${args.label} agent fields have no exact Cognia equivalent: ${unsupported.join(", ")}`
    );
    return;
  }
  if (typeof data.name === "string" && data.name !== args.id)
    warn2(
      result,
      "agents",
      path,
      `${args.label} display name "${data.name}" is not projected; the agent id is "${args.id}"`
    );
  delete data.name;
  const target = `${NORMALIZED}/agents/${args.id}.md`;
  if (result.files.has(target)) {
    block2(result, "agents", path, `Duplicate agent id ${args.id}`);
    return;
  }
  result.files.set(target, import_gray_matter4.default.stringify(parsed.content, data));
  result.transient.add(target);
  args.agents.push(`./${target}`);
}
function normalizeCommand(args) {
  const { path, result } = args;
  const text = args.files.get(path) ?? "";
  let parsed;
  try {
    parsed = path.endsWith(".txt") ? { content: text, data: {} } : (0, import_gray_matter4.default)(text);
  } catch (error) {
    block2(result, "commands", path, error instanceof Error ? error.message : String(error));
    return;
  }
  const unsupported = Object.keys(parsed.data).filter((key) => !args.allowed.includes(key));
  if (unsupported.length) {
    block2(
      result,
      "commands",
      path,
      `${args.label} command fields have no exact Cognia equivalent: ${unsupported.join(", ")}`
    );
    return;
  }
  if (/(^|\s)@[\w./-]*[./][\w./-]+/.test(parsed.content))
    warn2(
      result,
      "commands",
      path,
      `${args.label} inlines @file references when the command runs; the converted skill keeps them as literal text`
    );
  const target = `${NORMALIZED}/commands/${args.name}.md`;
  if (result.files.has(target)) {
    block2(result, "commands", path, `Duplicate command ${args.name}`);
    return;
  }
  result.files.set(target, import_gray_matter4.default.stringify(parsed.content, { ...parsed.data, name: args.name }));
  result.transient.add(target);
  args.commands.push(`./${target}`);
}
function normalizeHooks(args) {
  const value = read(args.files, args.path);
  const canonical = hookDocumentToCanonical({
    value,
    path: args.path,
    dialect: args.dialect,
    sink: args.result
  });
  const target = `${NORMALIZED}/hooks/${args.hooks.length}.json`;
  save(
    args.result.files,
    target,
    replaceRootTokens(canonical, args.tokens, [], "${CLAUDE_PLUGIN_ROOT}")
  );
  args.result.transient.add(target);
  args.hooks.push(`./${target}`);
}
function filesIn(files, dir, pattern, recursive = false) {
  const prefix = `${dir}/`;
  return [...files.keys()].filter(
    (path) => path.startsWith(prefix) && pattern.test(path) && (recursive || !path.slice(prefix.length).includes("/"))
  ).sort();
}
function immediateSkills(files, root) {
  return [...files.keys()].filter((path) => new RegExp(`^${root.replace(/[.]/g, "\\.")}/[^/]+/SKILL\\.md$`).test(path)).sort();
}
function nestedSkills(files, root) {
  if (files.has(`${root}/SKILL.md`)) return [`${root}/SKILL.md`];
  return [...files.keys()].filter((path) => path.startsWith(`${root}/`) && path.endsWith("/SKILL.md")).sort();
}
function normalizePlatformBundle(files, target) {
  const result = emptyProjection(files);
  const path = manifestPath(files, target);
  const consumed = /* @__PURE__ */ new Set();
  try {
    if (!files.has(path)) throw new Error(`Manifest not found: ${path}`);
    const source = read(files, path);
    if (target === "copilot" && path === "plugin.json" && typeof source.$schema === "string") {
      if (!apVersion(source)) {
        block2(
          result,
          "schema",
          `${path}.$schema`,
          "Copilot CLI rejects plugins that declare an unsupported Agent Plugins version"
        );
        return result;
      }
      return normalizePlatformBundle(files, "agent-plugins");
    }
    const manifest = Object.fromEntries(
      METADATA2.filter((key) => source[key] !== void 0).map((key) => [key, source[key]])
    );
    const agents = [];
    const commands = [];
    const hooks = [];
    let skills = [];
    let documents = [];
    let version;
    let name = source.name;
    if (target === "agent-plugins") {
      version = apVersion(source);
      if (!version)
        block2(
          result,
          "schema",
          `${path}.$schema`,
          `Unsupported Agent Plugins version; supported: ${AGENT_PLUGINS_SCHEMA_VERSIONS.join(", ")}`
        );
      validateApManifest(source, path, result);
      for (const key of Object.keys(source))
        if (![...METADATA2, "$schema", "extensions"].includes(key))
          warn2(
            result,
            key,
            `${path}.${key}`,
            "Agent Plugins hosts report and ignore unknown top-level fields; it was not projected"
          );
      if (object(source.extensions)) {
        for (const [namespace, value] of Object.entries(source.extensions))
          if (present(value))
            block2(
              result,
              "extensions",
              `${path}.extensions.${namespace}`,
              "Client extension data has client-defined semantics with no Cognia mapping"
            );
      }
      skills = immediateSkills(files, "skills");
      for (const nested of nestedSkills(files, "skills").filter((entry) => !skills.includes(entry)))
        warn2(
          result,
          "skills",
          nested,
          "Agent Plugins loads only immediate skills/<dir>/SKILL.md children; this skill is not loaded"
        );
      if (files.has("SKILL.md"))
        warn2(
          result,
          "skills",
          "SKILL.md",
          "Agent Plugins has no root SKILL.md fallback; it is not loaded"
        );
      if (files.has("mcp.json")) documents = [{ path: "mcp.json", value: read(files, "mcp.json") }];
      for (const agentPath of filesIn(files, "dev.openhands/agents", /\.md$/i)) {
        consumed.add(agentPath);
        normalizeAgent({
          files,
          path: agentPath,
          id: agentPath.split("/").pop().replace(/\.md$/i, ""),
          allowed: ["name", "description"],
          label: "OpenHands",
          result,
          agents
        });
      }
      for (const agentPath of filesIn(files, "com.github.copilot/agents", /\.md$/i)) {
        consumed.add(agentPath);
        normalizeAgent({
          files,
          path: agentPath,
          id: agentPath.split("/").pop().replace(/(?:\.agent)?\.md$/i, ""),
          allowed: ["name", "description"],
          label: "Copilot",
          result,
          agents
        });
      }
      for (const namespace of ["dev.openhands", "com.github.copilot"])
        for (const commandPath of filesIn(files, `${namespace}/commands`, /\.md$/i)) {
          consumed.add(commandPath);
          normalizeCommand({
            files,
            path: commandPath,
            name: commandPath.split("/").pop().replace(/\.md$/i, ""),
            allowed: ["description", "allowed-tools", "disable-model-invocation"],
            label: namespace,
            result,
            commands
          });
        }
      if (files.has("dev.openhands/hooks/hooks.json")) {
        consumed.add("dev.openhands/hooks/hooks.json");
        normalizeHooks({
          files,
          path: "dev.openhands/hooks/hooks.json",
          dialect: HOOK_DIALECTS.openhands,
          tokens: ["${PLUGIN_ROOT}"],
          result,
          hooks
        });
      }
      for (const [blocked2, capability, message] of [
        [
          "com.github.copilot/hooks/hooks.json",
          "hooks",
          "Copilot hook files use Copilot's own contract (version 1, flat bash/powershell entries, preToolUse fail-closed on non-zero exit); no exact Cognia mapping exists"
        ],
        [
          "com.github.copilot/lsp.json",
          "lspServers",
          "LSP servers need a language-server host; Cognia has no plugin LSP contribution"
        ]
      ])
        if (files.has(blocked2)) {
          consumed.add(blocked2);
          block2(result, capability, blocked2, message);
        }
      for (const rule of filesIn(files, "com.github.copilot/rules", /./, true)) {
        consumed.add(rule);
        block2(
          result,
          "rules",
          rule,
          "Copilot rules are always-on or conditional instructions; Cognia plugins have no rule contribution"
        );
      }
      for (const file of files.keys())
        if (file.startsWith("dev.openhands/") || file.startsWith("com.github.copilot/"))
          consumed.add(file);
    } else if (target === "copilot") {
      if (typeof source.name !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(source.name))
        warn2(
          result,
          "name",
          `${path}.name`,
          "Copilot legacy names allow letters, digits and hyphens (max 64); the host may refuse this plugin"
        );
      for (const key of Object.keys(source)) {
        if ([...METADATA2, "agents", "skills", "commands", "mcpServers"].includes(key)) continue;
        if (key === "category" || key === "tags")
          warn2(result, key, `${path}.${key}`, "Marketplace presentation metadata was not projected");
        else if (key === "hooks")
          block2(
            result,
            "hooks",
            `${path}.hooks`,
            "Copilot hook configuration uses Copilot's own contract; no exact Cognia mapping exists"
          );
        else if (key === "lspServers")
          block2(
            result,
            "lspServers",
            `${path}.lspServers`,
            "LSP servers need a language-server host"
          );
        else if (key === "extensions")
          block2(
            result,
            "extensions",
            `${path}.extensions`,
            "Copilot extension directories run host code"
          );
        else
          warn2(
            result,
            key,
            `${path}.${key}`,
            "Copilot reports and ignores unknown manifest fields; it was not projected"
          );
      }
      const skillRoots = source.skills !== void 0 ? pathsOf(source.skills) : ["skills"];
      skills = skillRoots.flatMap(
        (root) => root.endsWith(".md") ? [root] : nestedSkills(files, root)
      );
      if (source.skills === void 0 && skills.length === 0 && files.has("SKILL.md"))
        skills = ["SKILL.md"];
      for (const root of source.agents !== void 0 ? pathsOf(source.agents) : ["agents"])
        for (const agentPath of filesIn(files, root, /\.agent\.md$/i, true)) {
          consumed.add(agentPath);
          normalizeAgent({
            files,
            path: agentPath,
            id: agentPath.split("/").pop().replace(/\.agent\.md$/i, ""),
            allowed: ["name", "description"],
            label: "Copilot",
            result,
            agents
          });
        }
      for (const root of pathsOf(source.commands))
        for (const commandPath of filesIn(files, root, /\.md$/i, true)) {
          consumed.add(commandPath);
          normalizeCommand({
            files,
            path: commandPath,
            name: commandPath.split("/").pop().replace(/\.md$/i, ""),
            allowed: ["description", "allowed-tools", "disable-model-invocation"],
            label: "Copilot",
            result,
            commands
          });
        }
      documents = mcpDeclarations(
        files,
        source.mcpServers,
        [".mcp.json", ".github/mcp.json"],
        "replace",
        result
      );
    } else if (target === "cursor") {
      if (typeof source.name !== "string" || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(source.name))
        warn2(
          result,
          "name",
          `${path}.name`,
          "Cursor plugin names must be lowercase kebab-case; the host may refuse this plugin"
        );
      if (object(source.author))
        checkFields(source.author, ["name", "email"], `${path}.author`, result);
      for (const key of Object.keys(source))
        if (![
          ...METADATA2,
          "logo",
          "rules",
          "agents",
          "skills",
          "commands",
          "hooks",
          "mcpServers",
          "variables"
        ].includes(key))
          block2(result, key, `${path}.${key}`, "Field has no verified behavioral mapping");
      if (typeof source.logo === "string") manifest.icon = source.logo;
      for (const rule of source.rules !== void 0 ? pathsOf(source.rules) : ["rules"])
        for (const rulePath of rule.match(/\.(?:md|mdc|markdown)$/) ? [rule].filter((entry) => files.has(entry)) : filesIn(files, rule, /\.(?:md|mdc|markdown)$/i, true)) {
          consumed.add(rulePath);
          block2(result, "rules", rulePath, UNMAPPED_SURFACES.cursor[0][2]);
        }
      const skillRoots = source.skills !== void 0 ? pathsOf(source.skills) : ["skills"];
      skills = skillRoots.flatMap(
        (root) => root.endsWith(".md") ? [root] : source.skills !== void 0 ? nestedSkills(files, root) : immediateSkills(files, root)
      );
      if (source.skills === void 0 && skills.length === 0 && files.has("SKILL.md"))
        skills = ["SKILL.md"];
      for (const root of source.agents !== void 0 ? pathsOf(source.agents) : ["agents"])
        for (const agentPath of root.match(/\.(?:md|mdc|markdown)$/) ? [root] : filesIn(files, root, /\.(?:md|mdc|markdown)$/i, true)) {
          consumed.add(agentPath);
          normalizeAgent({
            files,
            path: agentPath,
            id: agentPath.split("/").pop().replace(/\.(?:md|mdc|markdown)$/i, ""),
            allowed: ["name", "description"],
            label: "Cursor",
            result,
            agents
          });
        }
      for (const root of source.commands !== void 0 ? pathsOf(source.commands) : ["commands"])
        for (const commandPath of root.match(/\.(?:md|mdc|markdown|txt)$/) ? [root] : filesIn(files, root, /\.(?:md|mdc|markdown|txt)$/i, true)) {
          consumed.add(commandPath);
          normalizeCommand({
            files,
            path: commandPath,
            name: commandPath.split("/").pop().replace(/\.(?:md|mdc|markdown|txt)$/i, ""),
            allowed: ["description"],
            label: "Cursor",
            result,
            commands
          });
        }
      if (object(source.hooks)) {
        const inline = hookDocumentToCanonical({
          value: source.hooks,
          path: `${path}.hooks`,
          dialect: HOOK_DIALECTS.cursor,
          sink: result
        });
        const hookPath = `${NORMALIZED}/hooks/inline.json`;
        save(
          result.files,
          hookPath,
          replaceRootTokens(inline, ["${CURSOR_PLUGIN_ROOT}"], [], "${CLAUDE_PLUGIN_ROOT}")
        );
        result.transient.add(hookPath);
        hooks.push(`./${hookPath}`);
      } else {
        const hookPath = typeof source.hooks === "string" ? stripDot(source.hooks) : "hooks/hooks.json";
        if (typeof source.hooks === "string" && !files.has(hookPath))
          throw new Error(`Hooks configuration not found: ${hookPath}`);
        if (files.has(hookPath)) {
          consumed.add(hookPath);
          normalizeHooks({
            files,
            path: hookPath,
            dialect: HOOK_DIALECTS.cursor,
            tokens: ["${CURSOR_PLUGIN_ROOT}"],
            result,
            hooks
          });
        }
      }
      documents = mcpDeclarations(files, source.mcpServers, ["mcp.json"], "replace", result);
      if (source.variables !== void 0) {
        const declarations = cursorVariables(source.variables, `${path}.variables`, result);
        result.settings = { declarations, servers: {} };
      }
    } else if (target === "kimi") {
      if (typeof source.name !== "string" || !/^[a-z0-9-]+$/.test(source.name))
        block2(
          result,
          "name",
          `${path}.name`,
          "Kimi plugin names allow lowercase letters, digits and hyphens only"
        );
      if (typeof source.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(source.version))
        block2(result, "version", `${path}.version`, "Kimi requires a semantic version");
      for (const key of Object.keys(source)) {
        if (["name", "version", "description", "config_file"].includes(key)) continue;
        if (key === "tools") {
          if (!Array.isArray(source.tools))
            block2(result, "tools", `${path}.tools`, "Kimi tools must be an array");
          else if (source.tools.length)
            block2(
              result,
              "tools",
              `${path}.tools`,
              "Kimi tools receive their parameters as one JSON object on stdin (cwd = plugin directory, 120 s timeout) and return stdout; Cognia cliTools map arguments to argv flags, so no exact mapping exists"
            );
        } else if (key === "inject") {
          if (present(source.inject))
            block2(
              result,
              "inject",
              `${path}.inject`,
              "Kimi injects the host's LLM API key and base URL into the plugin config; Cognia never copies credentials into plugins"
            );
        } else
          warn2(
            result,
            key,
            `${path}.${key}`,
            "Kimi ignores fields outside its plugin schema; it was not projected"
          );
      }
      if (source.config_file !== void 0 && !present(source.inject))
        warn2(
          result,
          "config_file",
          `${path}.config_file`,
          "config_file only receives injected credentials; without inject it has no behavior"
        );
      for (const key of ["homepage", "repository", "license", "keywords", "author"])
        delete manifest[key];
      if (files.has("SKILL.md")) {
        skills = ["SKILL.md"];
        const configFile = typeof source.config_file === "string" ? stripDot(source.config_file) : void 0;
        result.rootSkillResources = [...files.keys()].filter(
          (file) => file !== "SKILL.md" && file !== path && file !== configFile && !/(^|\/)\.env(?:\.|$)/.test(file) && !file.startsWith(".claude-plugin/")
        );
      }
      for (const nested of nestedSkills(files, "skills"))
        block2(
          result,
          "skills",
          nested,
          "Kimi treats only the plugin directory's root SKILL.md as a skill; this skill would never load"
        );
    } else if (target === "devin") {
      if (typeof source.name !== "string" || !/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(source.name))
        warn2(
          result,
          "name",
          `${path}.name`,
          "Devin plugin names are lowercase alphanumerics separated by single - or .; the host may refuse this plugin"
        );
      for (const key of Object.keys(source)) {
        if ([...METADATA2, "skills", "mcpServers"].includes(key)) continue;
        if (["requiredPlugins", "optionalPlugins", "forbiddenPlugins"].includes(key)) {
          if (present(source[key]))
            block2(
              result,
              key,
              `${path}.${key}`,
              "Plugin dependency and governance lists install or forbid other plugins; Cognia has no equivalent"
            );
        } else if (key === "hooks")
          block2(result, "hooks", `${path}.hooks`, UNMAPPED_SURFACES.devin[3][2]);
        else block2(result, key, `${path}.${key}`, "Field has no verified behavioral mapping");
      }
      if (Array.isArray(source.skills) && source.skills.length === 0) skills = [];
      else {
        const roots = source.skills !== void 0 ? pathsOf(source.skills) : ["skills"];
        for (const root of typeof source.skills === "string" || Array.isArray(source.skills) ? Array.isArray(source.skills) ? source.skills : [source.skills] : [])
          if (typeof root !== "string" || root.startsWith("/") || root.startsWith("~") || root.split("/").includes(".."))
            block2(result, "skills", `${path}.skills`, "Devin rejects absolute, ~ or .. skill paths");
        skills = roots.flatMap(
          (root) => root.endsWith(".md") ? [root] : nestedSkills(files, root)
        );
      }
      const declared = source.mcpServers;
      if (object(declared) && Array.isArray(declared.paths)) {
        for (const key of Object.keys(declared))
          if (!["paths", "exclusive"].includes(key))
            block2(
              result,
              "mcp",
              `${path}.mcpServers.${key}`,
              "Field has no verified behavioral mapping"
            );
        documents = mcpDeclarations(
          files,
          declared.paths,
          [".mcp.json"],
          declared.exclusive === true ? "replace" : "merge",
          result
        );
        if (declared.exclusive === true && files.has(".mcp.json")) {
          consumed.add(".mcp.json");
          result.files.set(".mcp.json", "{}\n");
        }
      } else if (object(declared)) {
        if (files.has(".mcp.json"))
          block2(
            result,
            "mcp",
            `${path}.mcpServers`,
            "Devin does not document whether inline servers merge with .mcp.json"
          );
        documents = mcpDeclarations(files, declared, [], "replace", result);
      } else documents = mcpDeclarations(files, declared, [".mcp.json"], "merge", result);
    } else {
      name = "opencode-resource-bundle";
      checkFields(source, ["$schema", "mcp"], path, result);
      documents = [{ path, value: source }];
      skills = [".opencode/skills", ".opencode/skill"].flatMap(
        (root) => immediateSkills(files, root)
      );
      for (const dir of [".opencode/commands", ".opencode/command"])
        for (const commandPath of filesIn(files, dir, /\.md$/i, true)) {
          consumed.add(commandPath);
          normalizeCommand({
            files,
            path: commandPath,
            name: commandPath.slice(dir.length + 1).replace(/\.md$/i, "").replaceAll("/", "-"),
            allowed: ["description"],
            label: "OpenCode",
            result,
            commands
          });
        }
      for (const dir of [".opencode/agents", ".opencode/agent"])
        for (const agentPath of filesIn(files, dir, /\.md$/i, true)) {
          consumed.add(agentPath);
          normalizeAgent({
            files,
            path: agentPath,
            id: agentPath.split("/").pop().replace(/\.md$/i, ""),
            allowed: ["description", "hidden", "color"],
            label: "OpenCode",
            result,
            agents,
            rewrite: (data) => {
              if (data.mode !== "subagent")
                return `OpenCode agent mode ${JSON.stringify(data.mode ?? "all")} also runs as a primary agent; only mode: subagent maps to a Cognia subagent`;
              delete data.mode;
              return null;
            }
          });
        }
    }
    adaptSkillSemantics(files, result, target, "import", skills);
    if (typeof name !== "string" || !name.trim()) throw new Error(`${path}.name is required`);
    manifest.name = name;
    const servers = target === "kimi" ? {} : mcpServers(documents, target, result, version);
    if (result.settings) result.settings.servers = servers;
    result.files.set(path, "{}\n");
    for (const document of documents)
      if (files.has(document.path) && document.path !== CLAUDE_MANIFEST2) {
        result.files.set(document.path, "{}\n");
        consumed.add(document.path);
      }
    if (Object.keys(servers).length) {
      const mcpPath = files.has(".mcp.json") && !documents.some((document) => document.path === ".mcp.json") ? `${NORMALIZED}/mcp.json` : ".mcp.json";
      save(result.files, mcpPath, { mcpServers: servers });
      if (!files.has(mcpPath)) result.transient.add(mcpPath);
      manifest.mcpServers = `./${mcpPath}`;
    }
    manifest.agents = agents;
    manifest.commands = commands;
    manifest.hooks = hooks;
    result.skills = skills;
    save(result.files, CLAUDE_MANIFEST2, manifest);
    if (!files.has(CLAUDE_MANIFEST2)) result.transient.add(CLAUDE_MANIFEST2);
    inventory(files, result, target, consumed);
    warn2(
      result,
      "compatibility",
      path,
      "Declarative normalization only; native host execution has not been verified"
    );
  } catch (error) {
    block2(result, "format", path, error instanceof Error ? error.message : String(error));
  }
  return result;
}
function cursorVariables(value, path, result) {
  if (!object(value) || value.type !== "object" || !object(value.properties)) {
    block2(
      result,
      "variables",
      path,
      "Cursor variables must be a JSON Schema object with properties"
    );
    return [];
  }
  for (const key of Object.keys(value))
    if (!["type", "properties", "required", "$schema", "title", "description"].includes(key))
      block2(
        result,
        "variables",
        `${path}.${key}`,
        "Variable schema keyword has no Cognia preset-field equivalent"
      );
  const declarations = [];
  for (const [envVar, raw] of Object.entries(value.properties)) {
    if (!object(raw) || raw.type !== void 0 && raw.type !== "string") {
      block2(
        result,
        "variables",
        `${path}.properties.${envVar}`,
        "Only string variables map to Cognia preset fields"
      );
      continue;
    }
    for (const key of Object.keys(raw))
      if (!["type", "title", "description"].includes(key))
        block2(
          result,
          "variables",
          `${path}.properties.${envVar}.${key}`,
          "Variable schema keyword has no Cognia preset-field equivalent"
        );
    declarations.push({
      envVar,
      name: typeof raw.title === "string" && raw.title.trim() ? raw.title : envVar,
      ...typeof raw.description === "string" ? { description: raw.description } : {},
      // Cursor stores variable values in its dashboard, never in the plugin.
      sensitive: true
    });
  }
  return declarations;
}
function projectPlatformBundle(files, target, options2 = {}) {
  const result = emptyProjection(files);
  const consumed = /* @__PURE__ */ new Set();
  try {
    if (!files.has(CLAUDE_MANIFEST2))
      throw new Error("A validated Claude bundle manifest is required");
    const source = read(files, CLAUDE_MANIFEST2);
    checkFields(
      source,
      [...METADATA2, "displayName", "skills", "agents", "mcpServers"],
      CLAUDE_MANIFEST2,
      result
    );
    const metadata = Object.fromEntries(
      METADATA2.filter((key) => source[key] !== void 0).map((key) => [key, source[key]])
    );
    if (["agent-plugins", "copilot"].includes(target))
      validateApManifest(metadata, PLATFORM_BUNDLE_PROFILES[target].manifest, result);
    if (target === "kimi" && (typeof metadata.name !== "string" || !/^[a-z0-9-]+$/.test(metadata.name)))
      block2(
        result,
        "name",
        "plugin.json.name",
        "Kimi plugin names allow lowercase letters, digits and hyphens only"
      );
    if (["agent-plugins", "copilot", "opencode", "kimi"].includes(target) && source.skills !== void 0) {
      const roots = Array.isArray(source.skills) ? source.skills : [source.skills];
      if (roots.length !== 1 || !["skills", "./skills", "./skills/"].includes(String(roots[0])))
        block2(
          result,
          "skills",
          "skills",
          "This target uses fixed skill locations; custom skill roots require resource relocation"
        );
    }
    adaptSkillSemantics(files, result, target, "export");
    const declared = source.mcpServers;
    let documents = [];
    if (typeof declared === "string") {
      const mcpPath = stripDot(declared);
      if (!files.has(mcpPath)) throw new Error(`MCP configuration not found: ${mcpPath}`);
      documents = [{ path: mcpPath, value: read(files, mcpPath) }];
    } else if (object(declared))
      documents = [
        {
          path: "mcpServers",
          value: "mcpServers" in declared ? declared : { mcpServers: declared }
        }
      ];
    else if (declared !== void 0)
      block2(
        result,
        "mcp",
        "mcpServers",
        "This MCP declaration shape requires a platform-specific merge adapter"
      );
    else if (files.has(".mcp.json"))
      documents = [{ path: ".mcp.json", value: read(files, ".mcp.json") }];
    const servers = mcpServers(documents, "devin", result);
    result.files.delete(CLAUDE_MANIFEST2);
    result.files.delete(".mcp.json");
    const agentFiles = [...files.keys()].filter((path) => /^agents\/[^/]+\.md$/.test(path));
    const hooksText = files.get("hooks/hooks.json");
    const projectAgents = (dir, suffix, allowed, label) => {
      for (const agentPath of agentFiles) {
        consumed.add(agentPath);
        result.files.delete(agentPath);
        const id = agentPath.slice("agents/".length, -".md".length);
        const parsed = (0, import_gray_matter4.default)(files.get(agentPath) ?? "");
        const unsupported = Object.keys(parsed.data).filter((key) => !allowed.includes(key));
        if (unsupported.length) {
          block2(
            result,
            "subagent",
            `subagents.${id}`,
            `${label} agents have no exact equivalent for: ${unsupported.join(", ")}`
          );
          continue;
        }
        result.files.set(`${dir}/${id}${suffix}`, files.get(agentPath));
      }
    };
    const projectHooks = (path, dialect, token) => {
      if (hooksText === void 0) return;
      consumed.add("hooks/hooks.json");
      result.files.delete("hooks/hooks.json");
      const document = JSON.parse(hooksText);
      const projected = canonicalHooksToDialect({
        hooks: document.hooks ?? {},
        dialect,
        sink: result,
        path
      });
      if (projected)
        save(
          result.files,
          path,
          replaceRootTokens(projected, ["${CLAUDE_PLUGIN_ROOT}"], [], token)
        );
    };
    if (target === "opencode") {
      warn2(
        result,
        "metadata",
        "opencode.json",
        "OpenCode resource configuration has no native plugin identity metadata; imported identity will be generated"
      );
      const mcp = {};
      for (const [name, value] of Object.entries(servers)) {
        const server = value;
        if (server.type !== "stdio" || JSON.stringify(server).includes("${")) {
          block2(
            result,
            "mcp",
            `mcpServers.${name}`,
            "OpenCode export requires a local command without plugin-root paths or unresolved variables (OpenCode has no plugin root)"
          );
          continue;
        }
        mcp[name] = {
          type: "local",
          command: [server.command, ...server.args ?? []],
          ...server.env ? { environment: server.env } : {},
          ...typeof server.cwd === "string" ? { cwd: server.cwd } : {}
        };
      }
      for (const [path, text] of Array.from(result.files))
        if (path.startsWith("skills/")) {
          result.files.set(`.opencode/${path}`, text);
          result.files.delete(path);
        }
      for (const agentPath of agentFiles) {
        consumed.add(agentPath);
        result.files.delete(agentPath);
        const id = agentPath.slice("agents/".length, -".md".length);
        const parsed = (0, import_gray_matter4.default)(files.get(agentPath) ?? "");
        const unsupported = Object.keys(parsed.data).filter(
          (key) => !["name", "description"].includes(key)
        );
        if (unsupported.length) {
          block2(
            result,
            "subagent",
            `subagents.${id}`,
            `OpenCode agents have no exact equivalent for: ${unsupported.join(", ")}`
          );
          continue;
        }
        const data = { description: parsed.data.description, mode: "subagent" };
        result.files.set(`.opencode/agents/${id}.md`, import_gray_matter4.default.stringify(parsed.content, data));
      }
      save(result.files, "opencode.json", { $schema: "https://opencode.ai/config.json", mcp });
    } else if (target === "agent-plugins" || target === "copilot") {
      save(result.files, "plugin.json", { $schema: AGENT_PLUGINS_SCHEMA, ...metadata });
      if (Object.keys(servers).length) {
        const portable = Object.fromEntries(
          Object.entries(servers).map(([name, value]) => {
            const server = replaceRootTokens(
              value,
              ["${CLAUDE_PLUGIN_ROOT}"],
              [],
              "${PLUGIN_ROOT}"
            );
            if (server.type === "stdio" && server.cwd === void 0)
              block2(
                result,
                "mcp",
                `mcpServers.${name}.cwd`,
                "Portable MCP defaults cwd to the plugin root; an explicit working directory is required to preserve source behavior"
              );
            if (server.cwd !== void 0 && (typeof server.cwd !== "string" || !/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$))/.test(server.cwd)))
              block2(
                result,
                "mcp",
                `mcpServers.${name}.cwd`,
                "Working directory is not representable by the portable plugin-root contract"
              );
            if (typeof server.command === "string" && server.command.startsWith("${PLUGIN_ROOT}/"))
              server.command = `./${server.command.slice("${PLUGIN_ROOT}/".length)}`;
            if (typeof server.command === "string" && server.command.includes("${"))
              block2(
                result,
                "mcp",
                `mcpServers.${name}.command`,
                "Agent Plugins never expands variables in command"
              );
            if (server.type !== "stdio" && JSON.stringify(server).includes("${PLUGIN_ROOT}"))
              block2(
                result,
                "mcp",
                `mcpServers.${name}`,
                "Agent Plugins passes remote server values through literally"
              );
            if (object(server.env) && ["PLUGIN_ROOT", "PLUGIN_DATA"].some((key) => key in server.env))
              block2(
                result,
                "mcp",
                `mcpServers.${name}.env`,
                "Portable MCP reserved runtime variables cannot be overridden"
              );
            return [
              name,
              { ...server, type: server.type === "http" ? "streamable-http" : server.type }
            ];
          })
        );
        save(result.files, "mcp.json", { $schema: AP_MCP_SCHEMA("1.0.0"), mcpServers: portable });
      }
      if (target === "copilot") {
        projectAgents("com.github.copilot/agents", ".agent.md", ["name", "description"], "Copilot");
        if (hooksText !== void 0) {
          consumed.add("hooks/hooks.json");
          result.files.delete("hooks/hooks.json");
          block2(
            result,
            "command-hooks",
            "commandHooks",
            "Copilot hook files use Copilot's own contract (version 1, flat bash/powershell entries, preToolUse fail-closed on non-zero exit); no exact projection exists"
          );
        }
      } else {
        projectAgents("dev.openhands/agents", ".md", ["name", "description"], "OpenHands");
        projectHooks("dev.openhands/hooks/hooks.json", HOOK_DIALECTS.openhands, "${PLUGIN_ROOT}");
        if (agentFiles.length || hooksText !== void 0)
          warn2(
            result,
            "client-namespace",
            "dev.openhands/",
            "Agents and hooks are written to the dev.openhands/ client namespace; other Agent Plugins hosts ignore client namespaces they do not support"
          );
      }
    } else if (target === "kimi") {
      if (Object.keys(servers).length)
        block2(result, "mcp", "mcpServers", "Kimi plugins cannot declare MCP servers");
      for (const agentPath of agentFiles) {
        consumed.add(agentPath);
        result.files.delete(agentPath);
        block2(result, "subagent", agentPath, "Kimi plugins cannot declare subagents");
      }
      if (hooksText !== void 0) {
        consumed.add("hooks/hooks.json");
        result.files.delete("hooks/hooks.json");
        block2(result, "command-hooks", "hooks/hooks.json", "Kimi plugins cannot declare hooks");
      }
      const skillFiles = [...result.files.keys()].filter(
        (path) => /^skills\/[^/]+\/SKILL\.md$/.test(path)
      );
      if (skillFiles.length > 1)
        block2(
          result,
          "skills",
          "skills",
          "A Kimi plugin directory holds exactly one root SKILL.md; split the skills into separate plugins"
        );
      else if (skillFiles.length === 1) {
        const prefix = skillFiles[0].slice(0, -"SKILL.md".length);
        for (const [path, text] of Array.from(result.files)) {
          if (!path.startsWith(prefix)) continue;
          const relative2 = path.slice(prefix.length);
          if (result.files.has(relative2) && !path.startsWith("skills/"))
            block2(
              result,
              "skills",
              relative2,
              "Moving the skill to the plugin root would overwrite another bundled file"
            );
          result.files.set(relative2, text);
          result.files.delete(path);
        }
      }
      save(result.files, "plugin.json", {
        name: metadata.name,
        version: typeof metadata.version === "string" ? metadata.version : "0.1.0",
        ...metadata.description ? { description: metadata.description } : {},
        tools: []
      });
    } else {
      const manifest = { ...metadata, ...source.skills ? { skills: source.skills } : {} };
      if (target === "devin" && typeof metadata.name === "string" && !/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(metadata.name))
        block2(
          result,
          "name",
          ".devin-plugin/plugin.json.name",
          "Devin plugin names are lowercase alphanumerics separated by single - or ."
        );
      if (target === "cursor") {
        if (typeof metadata.name !== "string" || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(metadata.name))
          block2(
            result,
            "name",
            ".cursor-plugin/plugin.json.name",
            "Cursor plugin names must be lowercase kebab-case"
          );
        if (object(metadata.author))
          manifest.author = Object.fromEntries(
            Object.entries(metadata.author).filter(([key]) => key !== "url")
          );
        projectAgents("agents", ".md", ["name", "description"], "Cursor");
        projectHooks("hooks/hooks.json", HOOK_DIALECTS.cursor, "${CURSOR_PLUGIN_ROOT}");
        if (options2.variables?.length)
          manifest.variables = {
            type: "object",
            properties: Object.fromEntries(
              options2.variables.map((variable) => [
                variable.envVar,
                {
                  type: "string",
                  title: variable.name,
                  ...variable.description ? { description: variable.description } : {}
                }
              ])
            ),
            required: options2.variables.map((variable) => variable.envVar)
          };
      }
      const token = target === "cursor" ? "${CURSOR_PLUGIN_ROOT}" : "${CLAUDE_PLUGIN_ROOT}";
      if (Object.keys(servers).length) {
        const projected = replaceRootTokens(servers, ["${CLAUDE_PLUGIN_ROOT}"], [], token);
        const path = target === "cursor" ? "mcp.json" : ".mcp.json";
        save(result.files, path, { mcpServers: projected });
        manifest.mcpServers = `./${path}`;
      }
      save(result.files, PLATFORM_BUNDLE_PROFILES[target].manifest, manifest);
    }
    inventory(result.files, result, target === "copilot" ? "agent-plugins" : target, consumed);
    if (target === "copilot") {
      for (const path of result.files.keys())
        if (path.startsWith("dev.openhands/"))
          block2(result, "platform-control", path, "Copilot ignores the OpenHands client namespace");
    }
    warn2(
      result,
      "compatibility",
      PLATFORM_BUNDLE_PROFILES[target].manifest,
      "Native host installation and execution require separate verification"
    );
  } catch (error) {
    block2(result, "format", CLAUDE_MANIFEST2, error instanceof Error ? error.message : String(error));
  }
  return result;
}

// lib/plugin/convert/pi-package.ts
var import_gray_matter5 = __toESM(require_gray_matter());
var PI_RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"];
var PI_HOST_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox"
];
var LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "preprepare",
  "postprepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack"
];
var PI_PREPARE_ARGS = [
  "install",
  "--omit=dev",
  "--omit=peer",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund"
];
var PI_PACKAGE_ID_FALLBACK = "pi-package";
var IGNORE_FILES = /* @__PURE__ */ new Set([".gitignore", ".ignore", ".fdignore"]);
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function issue(sink, kind, capability, path, message) {
  sink[kind].push({ capability, path, message, blocking: kind === "blocking" });
}
function piGlobToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const slashAfter = pattern[index + 2] === "/";
        source += slashAfter ? "(?:[^/]*(?:/|$))*" : ".*";
        index += slashAfter ? 2 : 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end < 0) source += "\\{";
      else {
        source += `(?:${pattern.slice(index + 1, end).split(",").map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        index = end;
      }
    } else if (char === "[") {
      const end = pattern.indexOf("]", index);
      if (end < 0) source += "\\[";
      else {
        source += `[${pattern.slice(index + 1, end).replace(/^!/, "^")}]`;
        index = end;
      }
    } else source += char.replace(/[.+^$()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
function stripDot2(path) {
  return path.replace(/^\.\//, "").replace(/\/+$/, "");
}
function basename(path) {
  return path.split("/").pop() ?? path;
}
function dirname(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}
function hasDotSegment(path) {
  return path.split("/").some((segment) => segment.startsWith("."));
}
function isDirectory(files, path) {
  const prefix = path ? `${path}/` : "";
  for (const file of files.keys()) if (file.startsWith(prefix)) return true;
  return false;
}
function children(files, dir) {
  const prefix = dir ? `${dir}/` : "";
  const fileSet = /* @__PURE__ */ new Set();
  const dirSet = /* @__PURE__ */ new Set();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const [head, ...tail] = rest.split("/");
    if (!head || head.startsWith(".") || head === "node_modules") continue;
    if (tail.length) dirSet.add(`${prefix}${head}`);
    else fileSet.add(`${prefix}${head}`);
  }
  return { files: [...fileSet].sort(), dirs: [...dirSet].sort() };
}
function readPiManifest(packageJson) {
  if (!isRecord2(packageJson.pi)) return null;
  const manifest = {};
  for (const field of PI_RESOURCE_TYPES) {
    const entries = packageJson.pi[field];
    if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string"))
      manifest[field] = entries;
  }
  return manifest;
}
function collectRecursive(ctx, dir, pattern) {
  ctx.walked.add(dir);
  const { files, dirs } = children(ctx.files, dir);
  const result = files.filter((path) => pattern.test(basename(path)));
  for (const child of dirs) result.push(...collectRecursive(ctx, child, pattern));
  return result;
}
function collectSkillEntries(ctx, dir, root) {
  ctx.walked.add(dir);
  const skillFile = dir ? `${dir}/SKILL.md` : "SKILL.md";
  if (ctx.files.has(skillFile)) return [skillFile];
  const { files, dirs } = children(ctx.files, dir);
  const result = [];
  if (dir === root) result.push(...files.filter((path) => path.endsWith(".md")));
  for (const child of dirs) result.push(...collectSkillEntries(ctx, child, root));
  return result;
}
function resolveExtensionEntries(ctx, dir) {
  const packageJsonPath = dir ? `${dir}/package.json` : "package.json";
  const text = ctx.files.get(packageJsonPath);
  if (text) {
    try {
      const nested = JSON.parse(text);
      const manifest = isRecord2(nested) ? readPiManifest(nested) : null;
      const entries = (manifest?.extensions ?? []).map((entry) => stripDot2(dir ? `${dir}/${stripDot2(entry)}` : entry)).filter((entry) => ctx.files.has(entry) || isDirectory(ctx.files, entry));
      if (entries.length) return entries;
    } catch {
    }
  }
  for (const index of ["index.ts", "index.js"]) {
    const path = dir ? `${dir}/${index}` : index;
    if (ctx.files.has(path)) return [path];
  }
  return null;
}
function collectExtensionEntries(ctx, dir) {
  ctx.walked.add(dir);
  const own = resolveExtensionEntries(ctx, dir);
  if (own) return own;
  const { files, dirs } = children(ctx.files, dir);
  const result = files.filter((path) => /\.(?:ts|js)$/.test(path));
  for (const child of dirs) result.push(...resolveExtensionEntries(ctx, child) ?? []);
  return result;
}
function collectResourceFiles(ctx, dir, type) {
  if (type === "skills") return collectSkillEntries(ctx, dir, dir);
  if (type === "extensions") return collectExtensionEntries(ctx, dir);
  return collectRecursive(ctx, dir, type === "prompts" ? /\.md$/ : /\.json$/);
}
function isOverride(entry) {
  return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}
function matchesPattern(path, pattern) {
  const regex = piGlobToRegExp(stripDot2(pattern));
  if (regex.test(path) || regex.test(basename(path))) return true;
  if (basename(path) !== "SKILL.md") return false;
  const parent = dirname(path);
  return regex.test(parent) || regex.test(basename(parent));
}
function matchesExact(path, pattern) {
  const normalized = stripDot2(pattern);
  return normalized === path || basename(path) === "SKILL.md" && normalized === dirname(path);
}
function applyOverrides(all, entries) {
  let result = [...all];
  const excludes = entries.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1));
  const force = entries.filter((entry) => entry.startsWith("+")).map((entry) => entry.slice(1));
  const remove = entries.filter((entry) => entry.startsWith("-")).map((entry) => entry.slice(1));
  if (excludes.length)
    result = result.filter((path) => !excludes.some((pattern) => matchesPattern(path, pattern)));
  for (const path of all)
    if (!result.includes(path) && force.some((pattern) => matchesExact(path, pattern)))
      result.push(path);
  if (remove.length)
    result = result.filter((path) => !remove.some((pattern) => matchesExact(path, pattern)));
  return result;
}
function expandGlob(files, pattern) {
  const regex = piGlobToRegExp(stripDot2(pattern));
  const candidates = /* @__PURE__ */ new Set();
  for (const path of files.keys()) {
    candidates.add(path);
    let parent = dirname(path);
    while (parent) {
      candidates.add(parent);
      parent = dirname(parent);
    }
  }
  return [...candidates].filter((path) => regex.test(path) && !hasDotSegment(path)).sort();
}
function discoverPiResources(files, packageJson) {
  const ctx = { files, walked: /* @__PURE__ */ new Set() };
  const manifest = readPiManifest(packageJson);
  const resources = { extensions: [], skills: [], prompts: [], themes: [] };
  const missing = [];
  for (const type of PI_RESOURCE_TYPES) {
    if (manifest) {
      const entries = manifest[type];
      if (!entries) continue;
      const sources = entries.filter((entry) => !isOverride(entry));
      const resolved = [];
      for (const entry of sources) {
        if (/[*?]/.test(entry)) {
          resolved.push(...expandGlob(files, entry));
          continue;
        }
        const path = stripDot2(entry);
        if (files.has(path) || isDirectory(files, path)) resolved.push(path);
        else missing.push({ type, entry });
      }
      const all = [];
      for (const path of resolved) {
        if (files.has(path)) all.push(path);
        else all.push(...collectResourceFiles(ctx, path, type));
      }
      resources[type] = [...new Set(applyOverrides([...new Set(all)], entries.filter(isOverride)))];
    } else if (isDirectory(files, type)) {
      resources[type] = collectResourceFiles(ctx, type, type);
    }
  }
  const ignoreFiles = [...files.keys()].filter(
    (path) => IGNORE_FILES.has(basename(path)) && ctx.walked.has(dirname(path))
  );
  return { manifest, resources, missing, ignoreFiles };
}
function convertPrompt(path, text, issues) {
  let parsed;
  try {
    parsed = (0, import_gray_matter5.default)(text);
  } catch (error) {
    issue(
      issues,
      "blocking",
      "prompts",
      path,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
  const unknown = Object.keys(parsed.data).filter(
    (key) => key !== "description" && key !== "argument-hint"
  );
  if (unknown.length) {
    issue(
      issues,
      "blocking",
      "prompts",
      path,
      `Pi prompt frontmatter has no exact Cognia equivalent: ${unknown.join(", ")}`
    );
    return null;
  }
  const name = basename(path).replace(/\.md$/i, "");
  const id = slugify(name);
  if (!id) {
    issue(issues, "blocking", "prompts", path, "Prompt file name cannot produce a skill id");
    return null;
  }
  if (parsed.data["argument-hint"] !== void 0)
    issue(
      issues,
      "warnings",
      "prompts",
      path,
      "argument-hint only labels the Pi prompt in its UI and was not projected"
    );
  const contextual = /\$(?:\d+|@|ARGUMENTS)|\$\{(?:\d+|@)(?::[^}]*)?\}/.test(parsed.content);
  if (contextual)
    issue(
      issues,
      "warnings",
      "prompts",
      path,
      "converted to an explicit skill; Pi argument placeholders ($1, $@, $ARGUMENTS, ${1:-default}, ${@:N}) stay literal"
    );
  issue(
    issues,
    "converted",
    "prompts",
    path,
    `converted Pi prompt /${name} to explicit skill ${id}`
  );
  return {
    skill: {
      id,
      name,
      description: typeof parsed.data.description === "string" ? parsed.data.description.trim() : "",
      invocationPolicy: "explicit",
      source: { kind: "inline", markdown: parsed.content.trim() }
    },
    contextual
  };
}
function describeExtension(path, text) {
  if (!text.trim()) return null;
  const kinds = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(/\bregister([A-Z][A-Za-z]*)\s*\(/g)) kinds.add(match[1]);
  const events = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(/\.on\(\s*["'`]([A-Za-z_:.-]+)["'`]/g)) events.add(match[1]);
  const parts = [
    ...[...kinds].sort().map((kind) => `register${kind}`),
    ...events.size ? [`events ${[...events].sort().join(", ")}`] : []
  ];
  return parts.length ? parts.join("; ") : null;
}
function planPiImport(files) {
  const issues = { converted: [], warnings: [], blocking: [] };
  const text = files.get("package.json");
  if (text === void 0) throw new Error("Pi package.json was not found");
  const parsed = JSON.parse(text);
  if (!isRecord2(parsed)) throw new Error("package.json must contain a JSON object");
  const packageJson = parsed;
  const name = typeof packageJson.name === "string" ? packageJson.name.trim() : "";
  if (!name) throw new Error("package.json.name is required for a Pi package");
  if (packageJson.pi !== void 0 && !isRecord2(packageJson.pi))
    issue(
      issues,
      "warnings",
      "pi-package",
      "package.json.pi",
      "Pi ignores a non-object pi manifest"
    );
  if (isRecord2(packageJson.pi)) {
    for (const [key, value] of Object.entries(packageJson.pi)) {
      if (PI_RESOURCE_TYPES.includes(key)) {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
          issue(
            issues,
            "warnings",
            "pi-package",
            `package.json.pi.${key}`,
            "Pi ignores resource fields that are not arrays of strings"
          );
      } else
        issue(
          issues,
          "warnings",
          "pi-package",
          `package.json.pi.${key}`,
          key === "image" || key === "video" ? "Pi gallery media is presentation only and was not projected" : "Pi does not read this manifest key"
        );
    }
  }
  const discovery = discoverPiResources(files, packageJson);
  for (const { type, entry } of discovery.missing)
    issue(
      issues,
      "warnings",
      "pi-package",
      `package.json.pi.${type}`,
      `Manifest entry ${JSON.stringify(entry)} resolves to nothing; Pi skips it`
    );
  for (const path of discovery.ignoreFiles)
    issue(
      issues,
      "blocking",
      "pi-package",
      path,
      "Pi applies this ignore file during resource discovery; conversion does not evaluate ignore rules and could select resources Pi skips"
    );
  const extensionEntries = discovery.resources.extensions;
  if (files.has("dist/index.js") || extensionEntries.includes("dist/index.js"))
    issue(
      issues,
      "blocking",
      "pi-package",
      "dist/index.js",
      "The package already uses dist/index.js, which the Cognia plugin entry would overwrite; move the extension build output"
    );
  const declaredExtensions = discovery.manifest?.extensions ?? [];
  if (declaredExtensions.some((entry) => /^(?:\.\/)?dist(?:\/|$)/.test(entry)))
    issue(
      issues,
      "blocking",
      "pi-package",
      "package.json.pi.extensions",
      "Extensions load from dist/, which plugin snapshots skip and the Cognia entry overwrites; ship sources or another output directory"
    );
  const skillFiles = discovery.resources.skills.filter((path) => path.endsWith(".md"));
  let contextual = false;
  const promptSkills = [];
  for (const path of discovery.resources.prompts) {
    const prompt = convertPrompt(path, files.get(path) ?? "", issues);
    if (!prompt) continue;
    contextual ||= prompt.contextual;
    promptSkills.push(prompt.skill);
  }
  for (const path of extensionEntries) {
    const description = describeExtension(path, files.get(path) ?? "");
    issue(
      issues,
      "warnings",
      "pi-package",
      path,
      description ? `Pi extension (${description}) is retained for Pi only; its tools, MCP servers and event handlers are not translated into Cognia tools` : "Pi extension is retained for Pi only; extension code is not translated into Cognia tools"
    );
  }
  if (extensionEntries.length)
    issue(
      issues,
      "warnings",
      "pi-package",
      "piPackages",
      "No hostedSession block was generated: loading this package into Cognia-hosted Pi sessions needs reviewed hostedSession.extensions/tools declarations written by the author"
    );
  for (const path of discovery.resources.themes)
    issue(issues, "converted", "pi-package", path, "Pi theme retained for Pi only");
  const dependencies = isRecord2(packageJson.dependencies) ? packageJson.dependencies : {};
  for (const host of PI_HOST_PACKAGES)
    if (host in dependencies)
      issue(
        issues,
        "warnings",
        "pi-package",
        `package.json.dependencies.${host}`,
        `${host} is provided by Pi; list it in peerDependencies with "*" instead of bundling it`
      );
  const scripts = isRecord2(packageJson.scripts) ? packageJson.scripts : {};
  for (const script of LIFECYCLE_SCRIPTS)
    if (typeof scripts[script] === "string")
      issue(
        issues,
        "warnings",
        "pi-package",
        `package.json.scripts.${script}`,
        "Lifecycle scripts never run: Cognia prepares dependencies with npm --ignore-scripts"
      );
  const peer = isRecord2(packageJson.peerDependencies) ? packageJson.peerDependencies["@earendil-works/pi-coding-agent"] : void 0;
  const minPiVersion = typeof peer === "string" ? /^(?:\^|~|>=)?\s*(\d+\.\d+\.\d+)$/.exec(peer.trim())?.[1] : void 0;
  const piPackage = {
    id: slugify(name) || PI_PACKAGE_ID_FALLBACK,
    name,
    ...typeof packageJson.description === "string" && packageJson.description.trim() ? { description: packageJson.description.trim() } : {},
    path: ".",
    ...minPiVersion ? { minPiVersion } : {},
    ...Object.keys(dependencies).length ? {
      prepare: {
        program: "npm",
        args: [...PI_PREPARE_ARGS],
        marker: "node_modules/.package-lock.json"
      }
    } : {}
  };
  issue(
    issues,
    "converted",
    "pi-package",
    "package.json",
    `retained the complete Pi package as piPackages.${piPackage.id}`
  );
  return {
    packageJson,
    metadata: {
      name,
      version: packageJson.version,
      description: packageJson.description,
      author: packageJson.author,
      license: packageJson.license,
      homepage: packageJson.homepage,
      repository: isRecord2(packageJson.repository) ? packageJson.repository.url : packageJson.repository,
      keywords: packageJson.keywords
    },
    skillFiles,
    promptSkills,
    piPackage,
    contextual,
    issues
  };
}
function packageFiles(files, packagePath) {
  const root = stripDot2(packagePath === "." ? "" : packagePath);
  const prefix = root ? `${root}/` : "";
  const result = /* @__PURE__ */ new Map();
  for (const [path, text] of files)
    if (path.startsWith(prefix)) result.set(path.slice(prefix.length), text);
  return result;
}
function skillBody(text) {
  try {
    return (0, import_gray_matter5.default)(text).content.trim();
  } catch {
    return text.trim();
  }
}
function classifySkillsForPiPackage(args) {
  const root = stripDot2(args.piPackage.path === "." ? "" : args.piPackage.path);
  const pkgFiles = packageFiles(args.files, args.piPackage.path);
  const packageJson = (() => {
    try {
      const value = JSON.parse(pkgFiles.get("package.json") ?? "{}");
      return isRecord2(value) ? value : {};
    } catch {
      return {};
    }
  })();
  const discovery = discoverPiResources(pkgFiles, packageJson);
  const byId = /* @__PURE__ */ new Map();
  for (const path of discovery.resources.skills) {
    const text = pkgFiles.get(path) ?? "";
    let name = basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path).replace(/\.md$/, "");
    try {
      const declared = (0, import_gray_matter5.default)(text).data.name;
      if (typeof declared === "string" && declared.trim()) name = declared;
    } catch {
    }
    byId.set(slugify(name), { path, body: skillBody(text) });
  }
  for (const path of discovery.resources.prompts)
    byId.set(slugify(basename(path).replace(/\.md$/, "")), {
      path,
      body: skillBody(pkgFiles.get(path) ?? "")
    });
  const remaining = [];
  const delivered = [];
  const collisions = [];
  for (const skill of args.skills) {
    const source = skill.source;
    if (source.kind === "local-bundle" || source.kind === "local-folder") {
      const dir = stripDot2(source.path === "." ? "" : source.path);
      const relative2 = root ? dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : null : dir;
      if (relative2 !== null) {
        const skillFile = relative2 ? `${relative2}/SKILL.md` : "SKILL.md";
        if (discovery.resources.skills.includes(skillFile)) {
          delivered.push(skill.id);
          continue;
        }
      }
    }
    const match = byId.get(skill.id);
    if (match && source.kind === "inline") {
      if (source.markdown.trim() === match.body) {
        delivered.push(skill.id);
        continue;
      }
      collisions.push({
        capability: "skills",
        path: `skills.${skill.id}`,
        message: `Skill ${skill.id} differs from the package's ${match.path}; exporting both would shadow one in Pi`,
        blocking: true
      });
      continue;
    }
    if (match) {
      collisions.push({
        capability: "skills",
        path: `skills.${skill.id}`,
        message: `Skill ${skill.id} collides with the package's ${match.path}`,
        blocking: true
      });
      continue;
    }
    remaining.push(skill);
  }
  return { remaining, delivered, collisions };
}
function isCogniaGenerated(path, text, generatedEntry) {
  return path === "plugin.json" || path === "dist/index.js" && text === generatedEntry;
}
function planPiExport(args) {
  const issues = { converted: [], warnings: [], blocking: [] };
  const { manifest } = args;
  const packages = manifest.piPackages ?? [];
  const files = /* @__PURE__ */ new Map();
  const copies = [];
  if (packages.length > 1) {
    issue(
      issues,
      "blocking",
      "pi-package",
      "piPackages",
      "A Pi package has exactly one root; split the plugin's Pi packages before exporting"
    );
    return { files, copies, issues };
  }
  const def = packages[0];
  let packageJson;
  if (def) {
    const root = stripDot2(def.path === "." ? "" : def.path);
    const prefix = root ? `${root}/` : "";
    for (const [path, text2] of args.files) {
      if (!path.startsWith(prefix)) continue;
      const relative2 = path.slice(prefix.length);
      if (!root && isCogniaGenerated(relative2, text2, args.generatedEntry)) continue;
      if (/(^|\/)\.env(?:\.|$)/.test(relative2)) continue;
      if (args.binaryPaths?.has(path)) copies.push({ from: path, to: relative2 });
      else files.set(relative2, text2);
    }
    const text = files.get("package.json");
    if (text === void 0) {
      issue(
        issues,
        "blocking",
        "pi-package",
        `${def.path}/package.json`,
        "Pi package.json is missing"
      );
      return { files, copies, issues };
    }
    const parsed = JSON.parse(text);
    if (!isRecord2(parsed)) {
      issue(issues, "blocking", "pi-package", "package.json", "package.json must contain an object");
      return { files, copies, issues };
    }
    packageJson = { ...parsed };
    if (typeof packageJson.name !== "string" || !packageJson.name.trim())
      packageJson.name = manifest.id;
    if (def.prepare)
      issue(
        issues,
        "warnings",
        "pi-package",
        `piPackages.${def.id}.prepare`,
        "Pi installs dependencies for npm and git sources only; a local `pi install` of this directory needs the dependency step run first"
      );
    if (def.hostedSession)
      issue(
        issues,
        "warnings",
        "pi-package",
        `piPackages.${def.id}.hostedSession`,
        "hostedSession declarations configure Cognia-hosted Pi sessions and are not part of the Pi package"
      );
    issue(
      issues,
      "converted",
      "pi-package",
      `piPackages.${def.id}`,
      `exported Pi package ${def.id}`
    );
  } else {
    packageJson = {
      name: manifest.id,
      version: manifest.version,
      ...manifest.description ? { description: manifest.description } : {},
      ...manifest.author ? { author: { ...manifest.author } } : {},
      ...manifest.license ? { license: manifest.license } : {},
      ...manifest.homepage ? { homepage: manifest.homepage } : {},
      ...manifest.repository ? { repository: manifest.repository } : {},
      keywords: [...manifest.keywords ?? []],
      pi: { skills: ["./skills"] }
    };
  }
  const keywords = Array.isArray(packageJson.keywords) ? packageJson.keywords.filter((keyword) => typeof keyword === "string") : [];
  if (!keywords.includes("pi-package")) keywords.push("pi-package");
  packageJson.keywords = keywords;
  const dependencies = isRecord2(packageJson.dependencies) ? packageJson.dependencies : {};
  for (const host of PI_HOST_PACKAGES)
    if (host in dependencies)
      issue(
        issues,
        "blocking",
        "pi-package",
        `package.json.dependencies.${host}`,
        `${host} must be a peerDependency ("*"); Pi refuses to load a bundled copy of its own host packages`
      );
  for (const [path, text] of args.exported) {
    if (files.has(path) && files.get(path) !== text) {
      issue(
        issues,
        "blocking",
        "skills",
        path,
        "An exported skill file would overwrite a different file in the Pi package"
      );
      continue;
    }
    files.set(path, text);
  }
  for (const copy of args.exportedCopies) copies.push(copy);
  const exportedSkillDirs = [
    ...new Set(
      [...args.exported.keys(), ...args.exportedCopies.map((copy) => copy.to)].filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path)).map((path) => dirname(path))
    )
  ];
  if (exportedSkillDirs.length && isRecord2(packageJson.pi)) {
    const pi = { ...packageJson.pi };
    const skills = Array.isArray(pi.skills) ? pi.skills.filter((entry) => typeof entry === "string") : [];
    const probe2 = new Map(files);
    for (const copy of copies) probe2.set(copy.to, "");
    const loaded = discoverPiResources(probe2, { ...packageJson, pi }).resources.skills;
    for (const dir of exportedSkillDirs)
      if (!loaded.includes(`${dir}/SKILL.md`)) skills.push(`./${dir}`);
    pi.skills = skills;
    packageJson.pi = pi;
  }
  files.set("package.json", `${JSON.stringify(packageJson, null, 2)}
`);
  const probe = new Map(files);
  for (const copy of copies) probe.set(copy.to, "");
  const finalSkills = discoverPiResources(probe, packageJson).resources.skills;
  for (const dir of exportedSkillDirs)
    if (!finalSkills.includes(`${dir}/SKILL.md`))
      issue(
        issues,
        "blocking",
        "skills",
        `${dir}/SKILL.md`,
        "Pi would not discover this exported skill with the package's resource rules"
      );
  return { files, copies, issues };
}

// lib/plugin/convert/ecosystem.ts
var import_gray_matter6 = __toESM(require_gray_matter());
var UnsupportedPluginConversionError = class extends Error {
  constructor(source, target, report) {
    const details = report.blocking.map((issue2) => `${issue2.path}: ${issue2.message}`).join("; ");
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
  const basename3 = normalizePath(path).split("/").pop() ?? path;
  return basename3.replace(/\.(md|json)$/i, "");
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
var DEFAULT_ROOT_TOKENS = {
  tokens: ["${CLAUDE_PLUGIN_ROOT}", "${CODEX_PLUGIN_ROOT}", "${PLUGIN_ROOT}", "${extensionPath}"],
  envVars: []
};
function replacePluginRootToken(value, roots = DEFAULT_ROOT_TOKENS) {
  return replaceRootTokens(value, roots.tokens, roots.envVars, "${COGNIA_PLUGIN_ROOT}");
}
var UNSUPPORTED_RUNTIME_TOKENS = [
  "${PLUGIN_DATA}",
  "${CLAUDE_PLUGIN_DATA}",
  "${COPILOT_PLUGIN_DATA}",
  "${QODER_PLUGIN_DATA}",
  "${CODEBUDDY_PLUGIN_DATA}",
  "${CLAUDE_PROJECT_DIR}",
  "${workspacePath}",
  "${user_config."
];
function rejectUnsupportedRuntimeTokens(args) {
  const found = UNSUPPORTED_RUNTIME_TOKENS.filter((token) => args.text.includes(token)).map(
    (token) => token.endsWith(".") ? `${token}KEY}` : token
  );
  if (found.length === 0) return false;
  args.report.blocking.push({
    capability: args.capability,
    path: args.path,
    message: `runtime variables have no equivalent Cognia binding: ${found.join(", ")}`,
    blocking: true
  });
  return true;
}
function unsupportedIssue(capability, target = "cognia") {
  return {
    capability,
    path: capability,
    message: `${capability} requires a ${target} adapter or host runtime; native conversion is not implemented`,
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
    homepage: optionalString(manifest.homepage) ?? optionalString(interfaceMetadata?.websiteUrl) ?? optionalString(interfaceMetadata?.websiteURL),
    repository: optionalString(manifest.repository),
    keywords: stringArray(manifest.keywords),
    icon: optionalString(interfaceMetadata?.logo) ?? optionalString(interfaceMetadata?.composerIcon) ?? optionalString(manifest.icon) ?? optionalString(manifest.logo),
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
  const hasCommandHooks = Object.values(contributions.commandHooks ?? {}).some(
    (groups) => Array.isArray(groups) && groups.length > 0
  );
  if (hasCommandHooks) capabilities.push("command-hooks");
  const piPackages = contributions.piPackages ?? [];
  if (piPackages.length > 0) capabilities.push("pi-package");
  const need = hasCommandHooks || piPackages.length > 0 || contributions.presets.some((preset) => preset.transport === "stdio") ? "host-process" : contributions.needsFilesystem ? "host-filesystem" : "portable";
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
      ...contributions.presets.length > 0 ? { mcpServerPresets: contributions.presets } : {},
      ...hasCommandHooks ? { commandHooks: contributions.commandHooks } : {},
      ...piPackages.length > 0 ? { piPackages } : {}
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
  if (!args.retainSourceManifests) {
    for (const path of VENDOR_MANIFEST_PATHS) if (output2.has(path)) output2.set(path, "{}\n");
  }
  for (const path of output2.keys()) {
    if (isPluginEnvironmentFile(path)) output2.set(path, "\n");
  }
  output2.set("plugin.json", serializeManifest(manifest));
  output2.set("dist/index.js", renderDist(manifest));
  return {
    source,
    target: "cognia",
    manifest,
    files: output2,
    copies: [...options2.binaryPaths ?? []].filter((path) => output2.has(path) && !isPluginEnvironmentFile(path)).map((path) => ({ from: path, to: path })),
    report
  };
}
function skillFilesBelow(files, root) {
  if (files.has(`${root}/SKILL.md`)) return [`${root}/SKILL.md`];
  return Array.from(files.keys()).map(normalizePath).filter((path) => path.startsWith(`${root}/`) && path.endsWith("/SKILL.md"));
}
function collectSkillMarkdownFiles(files, declared, mode = "replace", report) {
  const declaredPaths = pathList(declared);
  const roots = declaredPaths.length === 0 ? ["skills"] : mode === "additive" ? ["skills", ...declaredPaths] : declaredPaths;
  const result = /* @__PURE__ */ new Set();
  for (const root of roots) {
    if (/\.md$/i.test(root)) {
      if (files.has(root)) result.add(root);
      continue;
    }
    if (root === "") {
      if (files.has("SKILL.md")) result.add("SKILL.md");
      continue;
    }
    for (const path of skillFilesBelow(files, root)) result.add(path);
  }
  if (mode === "ambiguous" && declaredPaths.length > 0 && report) {
    const conventional = skillFilesBelow(files, "skills").filter((path) => !result.has(path));
    if (conventional.length)
      report.blocking.push({
        capability: "skills",
        path: "skills",
        message: "The manifest declares skill paths while skills/ holds other skills; this host does not document whether declared paths add to or replace skills/",
        blocking: true
      });
  }
  return Array.from(result).sort();
}
function rootSkillFiles(files, runtimeEntry) {
  return [...files.keys()].filter(
    (path) => path !== runtimeEntry && !isPluginEnvironmentFile(path) && !/^(?:\.(?:claude|codex|cursor|devin|factory|qoder|codebuddy|workbuddy|augment|goose)-plugin\/|\.plugin\/|\.cognia-normalized\/|\.github\/|\.opencode\/|(?:skills|agents|droids|commands|hooks|policies|rules|output-styles|workflows)\/|(?:plugin|gemini-extension|mcp|\.mcp|hooks|settings|opencode)\.jsonc?$)/.test(
      path
    )
  );
}
function convertSkillFiles(args) {
  const { files, declared, report } = args;
  const paths = args.explicit ? [...args.explicit] : collectSkillMarkdownFiles(files, declared, args.mode, report);
  if (!args.explicit && args.rootFallback !== false && !configured(declared) && files.has("SKILL.md") && !paths.includes("SKILL.md"))
    paths.unshift("SKILL.md");
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
    const standalone = !/(^|\/)SKILL\.md$/.test(skillFile);
    const directory = standalone ? "" : skillFile.slice(0, Math.max(0, skillFile.lastIndexOf("/")));
    const resources = standalone ? [] : directory ? filesBelow(files, directory) : args.rootResources ?? rootSkillFiles(files);
    const built = buildSkill(text, resources, displayNameFromPath(directory || skillFile));
    for (const message of built.blockers)
      report.blocking.push({ capability: "skills", path: skillFile, message, blocking: true });
    if (built.skill.source.kind === "local-bundle") {
      built.skill.source = { kind: "local-bundle", path: directory || "." };
    }
    skills.push(built.skill);
    needsFilesystem ||= built.needsFilesystem;
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
function mcpDocuments(files, declared, defaultPath, rootKey = "mcpServers", mode = "replace", report) {
  const documents = [];
  const declaredItems = Array.isArray(declared) ? declared : declared === void 0 ? [] : [declared];
  for (const item of declaredItems) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item;
      documents.push({ path: rootKey, value: rootKey in record ? record : { [rootKey]: record } });
    } else if (typeof item === "string" && item.trim()) {
      if (/^https?:\/\//i.test(item) || /\.(?:mcpb|dxt)$/i.test(item)) {
        report?.blocking.push({
          capability: "mcpServers",
          path: item,
          message: "Packaged (.mcpb/.dxt) or remote MCP declarations are installed by the host; no Cognia preset can be derived without fetching them",
          blocking: true
        });
        continue;
      }
      const path = normalizePath(item);
      const text = files.get(path);
      if (text === void 0) throw new Error(`declared MCP configuration was not found: ${path}`);
      documents.push({ path, value: parseJsonObject(text, path) });
    } else if (item !== void 0) {
      throw new Error("mcpServers must be a path, an inline server map, or an array of these");
    }
  }
  const conventional = files.has(defaultPath) && !documents.some((doc) => doc.path === defaultPath);
  if (conventional && (documents.length === 0 || mode === "merge"))
    documents.push({
      path: defaultPath,
      value: parseJsonObject(files.get(defaultPath), defaultPath)
    });
  else if (conventional && mode === "ambiguous")
    report?.blocking.push({
      capability: "mcpServers",
      path: defaultPath,
      message: `The manifest declares MCP servers while ${defaultPath} also exists; this host does not document whether they merge`,
      blocking: true
    });
  return documents;
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
    const canonicalText = JSON.stringify(replacePluginRootToken(document.value, args.roots));
    const declaredServers = document.value.mcpServers;
    let drafts;
    try {
      drafts = readMcpDrafts(canonicalText, args.adapterSourceName).drafts;
    } catch {
      args.report.blocking.push({
        capability: "mcpServers",
        path: document.path,
        message: "MCP configuration does not contain valid server declarations",
        blocking: true
      });
      continue;
    }
    if (declaredServers && typeof declaredServers === "object" && !Array.isArray(declaredServers)) {
      for (const name of Object.keys(declaredServers)) {
        if (!drafts.some((draft) => draft.name === name))
          args.report.blocking.push({
            capability: "mcpServers",
            path: `${document.path}.${name}`,
            message: "Declared MCP server could not be parsed; conversion cannot silently omit it",
            blocking: true
          });
      }
    }
    if (args.output.has(document.path)) args.output.set(document.path, "{}\n");
    for (const path of VENDOR_MANIFEST_PATHS)
      if (args.output.has(path)) args.output.set(path, "{}\n");
    for (const path of args.output.keys())
      if (isPluginEnvironmentFile(path)) args.output.set(path, "\n");
    for (const draft of drafts) {
      const hostFields = [
        "excludeTools",
        "includeTools",
        "disabled",
        "enabled",
        "trust",
        "autoApprove"
      ].filter((field) => draft.config[field] !== void 0);
      if (hostFields.length)
        args.report.blocking.push({
          capability: "mcpServers",
          path: `${document.path}.${draft.name}`,
          message: `Host-specific MCP policy requires an enforcement adapter: ${hostFields.join(", ")}`,
          blocking: true
        });
      const sanitized = sanitizeMcpConfig(draft.transport, draft.config);
      const env = draft.config.env;
      for (const [key, value] of Object.entries(env ?? {})) {
        if (typeof value === "string" && value.startsWith("${COGNIA_PLUGIN_ROOT}")) {
          ;
          sanitized.config.env[key] = value;
          sanitized.fields = sanitized.fields.filter(
            (field) => !(field.placement === "env" && field.key === key)
          );
        }
      }
      const preset = {
        id: draft.name,
        name: draft.name,
        description: describeConfig(draft.transport, sanitized.config),
        transport: draft.transport,
        config: sanitized.config,
        fields: sanitized.fields
      };
      for (const field of sanitized.fields.filter(
        (field2) => field2.secret || field2.placement === "url"
      )) {
        const original = field.placement === "env" ? draft.config.env?.[field.key] : field.placement === "header" ? draft.config.headers?.[field.key] : draft.config.url;
        if (typeof original !== "string" || !original || /^\$\{[A-Z0-9_]+\}$/.test(original))
          continue;
        for (const [path, contents] of args.output) {
          if (contents.includes(original))
            args.report.blocking.push({
              capability: "secrets",
              path,
              message: "A credential removed from MCP configuration is also present in this bundled file; remove it before conversion",
              blocking: true
            });
        }
      }
      presets.push(preset);
      if (sanitized.fields.length)
        args.report.warnings.push({
          capability: "mcpServers",
          path: document.path,
          message: `User configuration required for ${draft.name}: ${sanitized.fields.map((field) => field.key).join(", ")}; source values were removed`,
          blocking: false
        });
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
var CONVERTIBLE_HOOK_HANDLER_TYPES = /* @__PURE__ */ new Set([
  "command",
  "http",
  "webhook",
  "prompt",
  "agent",
  "mcp_tool"
]);
function collectHookDocuments(args) {
  const { files, declared, sourcePath, report } = args;
  const documents = [];
  const seen = /* @__PURE__ */ new Set();
  const addFile = (path) => {
    const normalized = normalizePath(path);
    if (seen.has(normalized)) return;
    const text = files.get(normalized);
    if (text === void 0) return;
    seen.add(normalized);
    documents.push({ path: normalized, value: parseJsonObject(text, normalized) });
  };
  const addDeclared = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => addDeclared(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === "string" && value.trim()) {
      const normalized = normalizePath(value);
      if (!files.has(normalized))
        report.blocking.push({
          capability: "commandHooks",
          path: normalized,
          message: "declared hooks file was not found",
          blocking: true
        });
      else addFile(normalized);
    } else if (value && typeof value === "object") {
      documents.push({ path, value });
    } else if (value !== void 0) {
      report.blocking.push({
        capability: "commandHooks",
        path,
        message: "manifest hooks field must be a file path, inline event map, or array of these",
        blocking: true
      });
    }
  };
  addDeclared(declared, `${sourcePath}.hooks`);
  const declaredCount = documents.length;
  const defaults = (args.defaultFiles ?? ["hooks/hooks.json", "hooks.json"]).filter(
    (path) => files.has(path) && !seen.has(path)
  );
  const mode = args.mode ?? "merge";
  if (args.defaultDiscovery !== false) {
    if (declaredCount === 0 || mode === "merge") for (const path of defaults) addFile(path);
    else if (mode === "ambiguous" && defaults.length)
      report.blocking.push({
        capability: "commandHooks",
        path: defaults[0],
        message: "The manifest declares hooks while the conventional hook file also exists; this host does not document whether they merge",
        blocking: true
      });
  }
  return documents;
}
function convertHookDocuments(args) {
  const { report } = args;
  const documents = args.dialect ? args.documents.map((document) => ({
    path: document.path,
    value: hookDocumentToCanonical({
      value: document.value,
      path: document.path,
      dialect: args.dialect,
      sink: report
    })
  })) : args.documents;
  const merged = {};
  let convertedGroups = 0;
  for (const document of documents) {
    const text = JSON.stringify(document.value);
    rejectUnsupportedRuntimeTokens({
      text,
      capability: "commandHooks",
      path: document.path,
      report
    });
    const canonical = replacePluginRootToken(document.value, args.roots);
    const inner = canonical.hooks;
    const eventMap = inner && typeof inner === "object" && !Array.isArray(inner) ? inner : canonical;
    for (const [event, groups] of Object.entries(eventMap)) {
      if (!HOOK_EVENTS.includes(event)) {
        report.blocking.push({
          capability: "commandHooks",
          path: document.path,
          message: `hook event "${event}" has no Cognia hook-runtime equivalent (install/update lifecycle events are not dispatched to command hooks)`,
          blocking: true
        });
        continue;
      }
      if (!Array.isArray(groups)) {
        report.blocking.push({
          capability: "commandHooks",
          path: document.path,
          message: `hook event "${event}" must map to an array of groups`,
          blocking: true
        });
        continue;
      }
      let usable = true;
      for (const [index, group] of groups.entries()) {
        if (!group || typeof group !== "object" || Array.isArray(group)) {
          report.blocking.push({
            capability: "commandHooks",
            path: document.path,
            message: `hook group "${event}"[${index}] must be an object`,
            blocking: true
          });
          usable = false;
          continue;
        }
        const unknownGroupKeys = Object.keys(group).filter(
          (key) => !["matcher", "hooks"].includes(key)
        );
        if (unknownGroupKeys.length) {
          report.blocking.push({
            capability: "commandHooks",
            path: document.path,
            message: `Unsupported hook group selectors/fields: ${unknownGroupKeys.join(", ")}`,
            blocking: true
          });
          usable = false;
        }
        const handlers = group.hooks;
        if (!Array.isArray(handlers)) {
          report.blocking.push({
            capability: "commandHooks",
            path: document.path,
            message: `hook group "${event}"[${index}] must carry a "hooks" handler array`,
            blocking: true
          });
          usable = false;
          continue;
        }
        for (const [handlerIndex, handler] of handlers.entries()) {
          const type = handler && typeof handler === "object" && !Array.isArray(handler) ? handler.type : void 0;
          if (handler && typeof handler === "object" && !Array.isArray(handler)) {
            const record = handler;
            const supported = /* @__PURE__ */ new Set([
              "type",
              "timeout",
              ...type === "command" ? ["command", "async"] : type === "http" || type === "webhook" ? ["url", "headers"] : type === "prompt" || type === "agent" ? ["prompt", "model"] : type === "mcp_tool" ? ["server", "tool", "input"] : []
            ]);
            const unknown = Object.keys(record).filter(
              (key) => !supported.has(key) && !DORMANT_HOOK_HANDLER_FIELDS.includes(key)
            );
            if (unknown.length) {
              report.blocking.push({
                capability: "commandHooks",
                path: document.path,
                message: `Unsupported hook handler fields: ${unknown.join(", ")}`,
                blocking: true
              });
              usable = false;
            }
            if (record.timeout !== void 0 && (typeof record.timeout !== "number" || !Number.isFinite(record.timeout) || record.timeout <= 0) || record.async !== void 0 && typeof record.async !== "boolean") {
              report.blocking.push({
                capability: "commandHooks",
                path: document.path,
                message: "Hook timeout must be a positive number and async must be boolean",
                blocking: true
              });
              usable = false;
            }
            const dormant = DORMANT_HOOK_HANDLER_FIELDS.filter((field) => configured(record[field]));
            if (dormant.length) {
              report.blocking.push({
                capability: "commandHooks",
                path: document.path,
                message: `Cognia runners do not execute hook fields: ${dormant.join(", ")}`,
                blocking: true
              });
              usable = false;
            }
            const required = type === "command" ? "command" : type === "http" || type === "webhook" ? "url" : type === "prompt" || type === "agent" ? "prompt" : void 0;
            if (type === "mcp_tool" && (!optionalString(record.server) || !optionalString(record.tool))) {
              report.blocking.push({
                capability: "commandHooks",
                path: document.path,
                message: "MCP hook handler requires non-empty server and tool identifiers",
                blocking: true
              });
              usable = false;
            }
            if (required && !optionalString(record[required])) {
              report.blocking.push({
                capability: "commandHooks",
                path: document.path,
                message: `hook handler requires a non-empty ${required}`,
                blocking: true
              });
              usable = false;
            }
          }
          if (typeof type !== "string" || !CONVERTIBLE_HOOK_HANDLER_TYPES.has(type)) {
            report.blocking.push({
              capability: "commandHooks",
              path: document.path,
              message: `hook handler "${event}"[${index}].hooks[${handlerIndex}] has unsupported type ${JSON.stringify(type ?? null)} \u2014 only ${[...CONVERTIBLE_HOOK_HANDLER_TYPES].join("/")} handlers convert`,
              blocking: true
            });
            usable = false;
          }
        }
      }
      if (!usable) continue;
      const target = merged[event] ??= [];
      for (const group of groups) {
        target.push(group);
        convertedGroups += 1;
      }
    }
    if (convertedGroups > 0) {
      report.converted.push({
        capability: "commandHooks",
        path: document.path,
        message: `converted ${convertedGroups} hook group(s) into manifest.commandHooks`,
        blocking: false
      });
      convertedGroups = 0;
    }
  }
  return merged;
}
function detectPluginEcosystem(files) {
  return detectPluginBundle(files).ecosystem;
}
function isRecord3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function convertMarkdownAgent(args) {
  const { path, report } = args;
  let text = args.text;
  if (args.allowedFields) {
    let parsed2;
    try {
      parsed2 = (0, import_gray_matter6.default)(text);
    } catch (error) {
      report.blocking.push({
        capability: "agents",
        path,
        message: `frontmatter parse failed: ${error instanceof Error ? error.message : String(error)}`,
        blocking: true
      });
      return null;
    }
    const data = { ...parsed2.data };
    for (const [from, to] of Object.entries(args.renames ?? {})) {
      if (data[from] === void 0) continue;
      data[to] = data[from];
      delete data[from];
    }
    for (const [key, value] of Object.entries(args.defaults ?? {}))
      if (data[key] === value) delete data[key];
    const unsupported = Object.keys(data).filter((key) => !args.allowedFields.includes(key));
    if (unsupported.length) {
      report.blocking.push({
        capability: "agents",
        path,
        message: `${args.label} agent fields have no exact Cognia equivalent: ${unsupported.join(", ")}`,
        blocking: true
      });
      return null;
    }
    if (typeof data.name === "string" && slugify(data.name) !== slugify(args.id))
      report.warnings.push({
        capability: "agents",
        path,
        message: `${args.label} display name "${data.name}" is not projected; the agent id is "${slugify(args.id)}"`,
        blocking: false
      });
    delete data.name;
    text = import_gray_matter6.default.stringify(parsed2.content, data);
  }
  rejectUnsupportedRuntimeTokens({ text, capability: "agents", path, report });
  const parsed = parseMarkdownAgent(slugify(args.id), text);
  if ("error" in parsed) {
    report.blocking.push({ capability: "agents", path, message: parsed.error, blocking: true });
    return null;
  }
  if (parsed.unsupportedFields.length > 0) {
    report.blocking.push({
      capability: "agents",
      path,
      message: `unsupported subagent fields: ${parsed.unsupportedFields.join(", ")}`,
      blocking: true
    });
    return null;
  }
  report.converted.push({
    capability: "agents",
    path,
    message: `converted subagent ${parsed.id}`,
    blocking: false
  });
  return { id: parsed.id, name: parsed.id, ...parsed.def };
}
function convertCommandMap(args) {
  const skills = [];
  for (const [name, raw] of Object.entries(args.commands)) {
    const path = `commands.${name}`;
    if (!isRecord3(raw)) {
      args.report.blocking.push({
        capability: "commands",
        path,
        message: "command entries must be objects with source or content",
        blocking: true
      });
      continue;
    }
    const unknown = Object.keys(raw).filter(
      (key) => !["source", "content", "description", "argumentHint", "allowedTools"].includes(key)
    );
    if (unknown.length) {
      args.report.blocking.push({
        capability: "commands",
        path,
        message: `command fields have no exact Cognia equivalent: ${unknown.join(", ")}`,
        blocking: true
      });
      continue;
    }
    let body;
    if (typeof raw.content === "string") body = raw.content;
    else if (typeof raw.source === "string") {
      const sourcePath = normalizePath(raw.source);
      body = args.files.get(sourcePath);
      if (body === void 0) {
        args.report.blocking.push({
          capability: "commands",
          path,
          message: `command source was not found: ${sourcePath}`,
          blocking: true
        });
        continue;
      }
    } else {
      args.report.blocking.push({
        capability: "commands",
        path,
        message: "command entries require source or content",
        blocking: true
      });
      continue;
    }
    if (raw.argumentHint !== void 0)
      args.report.warnings.push({
        capability: "commands",
        path,
        message: "argumentHint only labels the command in the host UI and was not projected",
        blocking: false
      });
    const parsed = (0, import_gray_matter6.default)(body);
    const data = { ...parsed.data, name };
    if (typeof raw.description === "string") data.description = raw.description;
    if (Array.isArray(raw.allowedTools)) data["allowed-tools"] = raw.allowedTools;
    rejectUnsupportedRuntimeTokens({
      text: body,
      capability: "commands",
      path,
      report: args.report
    });
    const built = buildSkill(import_gray_matter6.default.stringify(parsed.content, data), [], name);
    for (const message of built.blockers)
      args.report.blocking.push({ capability: "commands", path, message, blocking: true });
    skills.push(built.skill);
    args.report.converted.push({
      capability: "commands",
      path,
      message: `converted prompt command to skill ${built.skill.id}`,
      blocking: false
    });
  }
  return skills;
}
function convertClaudePlugin(files, options2, profile = CLAUDE_FAMILY_PROFILES["claude-code"], overrides = {}) {
  const sourcePath = claudeFamilyManifestPath(files, profile) ?? profile.manifestPaths[0];
  const source = parseJsonObject(requiredString(files.get(sourcePath), sourcePath), sourcePath);
  const roots = { tokens: profile.rootTokens, envVars: profile.rootEnvVars };
  const honored = new Set(profile.componentFields);
  const report = {
    fidelity: "structured",
    converted: [],
    warnings: [],
    blocking: []
  };
  const fail = (capability, path, message) => report.blocking.push({ capability, path, message, blocking: true });
  const warn3 = (capability, path, message) => report.warnings.push({ capability, path, message, blocking: false });
  for (const field of Object.keys(source).sort()) {
    const value = source[field];
    if (profile.metadataFields.includes(field) || honored.has(field)) continue;
    if (Object.hasOwn(profile.ignoredFields, field)) {
      if (configured(value)) warn3(field, `${sourcePath}.${field}`, profile.ignoredFields[field]);
      continue;
    }
    if (Object.hasOwn(profile.blockedFields, field)) {
      if (configured(value)) fail(field, field, profile.blockedFields[field]);
      continue;
    }
    if (profile.unknownFields === "warn")
      warn3(
        field,
        `${sourcePath}.${field}`,
        `${profile.label} ignores unknown manifest keys; this field carries no behavior there and was not projected`
      );
    else
      fail(
        field,
        `${sourcePath}.${field}`,
        "unknown manifest field may carry behavior and cannot be converted safely"
      );
  }
  if (typeof source.name === "string" && !profile.nameRule.pattern.test(source.name))
    warn3(
      "name",
      `${sourcePath}.name`,
      `${profile.nameRule.message}; the host may refuse this plugin`
    );
  if (profile.requireDotSlashPaths) {
    for (const field of honored) {
      const value = source[field];
      const paths = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
      for (const path of paths)
        if (!path.startsWith("./") && !(field === "skills" && path === "."))
          warn3(
            field,
            `${sourcePath}.${field}`,
            `${profile.label} requires component paths to start with ./ (got ${JSON.stringify(path)}); the host may refuse this manifest`
          );
    }
  }
  for (const entry of profile.blockedPaths) {
    const present2 = Array.from(files.keys()).some(
      (path) => entry.path.endsWith("/") ? normalizePath(path).startsWith(entry.path) : normalizePath(path) === entry.path
    );
    if (!present2) continue;
    if ("warn" in entry && entry.warn) warn3(entry.capability, entry.path, entry.message);
    else if (!report.blocking.some((issue2) => issue2.capability === entry.capability))
      fail(entry.capability, entry.path, entry.message);
  }
  const commandHooks = convertHookDocuments({
    documents: collectHookDocuments({
      files,
      declared: honored.has("hooks") ? source.hooks : void 0,
      sourcePath,
      report,
      defaultFiles: profile.hookFiles,
      mode: profile.hooksMode,
      defaultDiscovery: overrides.hookDefaults !== false
    }),
    report,
    roots,
    dialect: profile.hookDialect.id === "claude-code" ? void 0 : profile.hookDialect
  });
  if (report.blocking.length > 0) {
    report.fidelity = "unsupported";
    throw new UnsupportedPluginConversionError(profile.ecosystem, "cognia", report);
  }
  const output2 = cloneFiles(files);
  const convertedSkills = convertSkillFiles({
    files,
    declared: honored.has("skills") ? source.skills : void 0,
    output: output2,
    report,
    mode: overrides.skillsMode ?? profile.skillsMode,
    explicit: overrides.explicitSkills,
    rootResources: overrides.rootSkillResources
  });
  const skills = convertedSkills.skills;
  if (profile.commandsDir) {
    const declaredCommands = honored.has("commands") ? source.commands : void 0;
    if (isRecord3(declaredCommands)) {
      if (profile.ecosystem === "claude-code")
        skills.push(...convertCommandMap({ commands: declaredCommands, files, report }));
      else
        fail(
          "commands",
          `${sourcePath}.commands`,
          `${profile.label} does not document inline command maps`
        );
    } else {
      const commandConversionStart = report.converted.length;
      for (const path of pathList(declaredCommands, profile.commandsDir)) {
        const below = path.toLowerCase().endsWith(".md") ? [path] : Array.from(files.keys()).filter((file) => normalizePath(file).startsWith(`${path}/`));
        for (const commandPath of below) {
          if (!/\.md$/i.test(commandPath)) {
            if (profile.ecosystem === "factory-droid")
              fail(
                "commands",
                commandPath,
                "Droid executable command files run host code; Cognia has no executable slash-command contribution"
              );
            continue;
          }
          const text = files.get(commandPath);
          if (text === void 0) continue;
          rejectUnsupportedRuntimeTokens({
            text,
            capability: "commands",
            path: commandPath,
            report
          });
          const built = buildSkill(text, [], displayNameFromPath(commandPath));
          for (const message of built.blockers)
            report.blocking.push({
              capability: "commands",
              path: commandPath,
              message,
              blocking: true
            });
          skills.push(built.skill);
          report.converted.push({
            capability: "commands",
            path: commandPath,
            message: `converted prompt command to skill ${built.skill.id}`,
            blocking: false
          });
        }
      }
      if (configured(declaredCommands) && report.converted.length === commandConversionStart)
        fail(
          "commands",
          "commands",
          "declared command paths did not contain Markdown command files"
        );
    }
  }
  const subagents = [];
  const agentConversionStart = report.converted.length;
  const declaredAgents = honored.has("agents") ? source.agents : void 0;
  for (const path of pathList(declaredAgents, profile.agentsDir)) {
    const candidates = path.toLowerCase().endsWith(".md") ? [path] : Array.from(files.keys()).filter(
      (file) => normalizePath(file).startsWith(`${path}/`) && /\.md$/i.test(file)
    );
    for (const agentPath of candidates) {
      const text = files.get(agentPath);
      if (text === void 0) continue;
      const id = profile.agentId(normalizePath(agentPath).split("/").pop() ?? agentPath);
      if (!id) continue;
      const agent = convertMarkdownAgent({
        path: agentPath,
        text,
        id,
        label: profile.label,
        allowedFields: profile.agentFields,
        defaults: profile.agentDefaults,
        report
      });
      if (agent) subagents.push(agent);
    }
  }
  if (configured(declaredAgents) && report.converted.length === agentConversionStart)
    fail("agents", "agents", "declared agent paths did not contain valid Markdown agents");
  const presets = convertMcpDocuments({
    documents: mcpDocuments(
      files,
      honored.has("mcpServers") ? source.mcpServers : void 0,
      profile.mcpFile,
      "mcpServers",
      overrides.mcpMode ?? profile.mcpMode,
      report
    ),
    adapterSourceName: "claude-code.json",
    output: output2,
    report,
    roots
  });
  if (overrides.settings)
    importInstallSettings({
      declarations: overrides.settings.declarations,
      presets,
      servers: overrides.settings.servers,
      report,
      capability: "variables",
      exposeToStdio: false
    });
  return finalizeForeignConversion({
    source: profile.ecosystem,
    output: output2,
    metadata: metadataFromForeignManifest(source, sourcePath),
    contributions: {
      skills,
      subagents,
      presets,
      commandHooks,
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
    ["apps", source.apps],
    ["extensions", source.extensions]
  ].filter(([, value]) => configured(value)).map(([capability]) => unsupportedIssue(String(capability)));
  if (files.has(".app.json") && !configured(source.apps)) blocking.push(unsupportedIssue("apps"));
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
      "interface",
      "extensions",
      "commands"
    ]),
    sourcePath,
    report
  });
  const commandHooks = convertHookDocuments({
    documents: collectHookDocuments({
      files,
      declared: source.hooks,
      sourcePath,
      report,
      defaultDiscovery: source.hooks === void 0,
      defaultFiles: ["hooks/hooks.json"]
    }),
    report,
    roots: {
      tokens: ["${PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}", "${CODEX_PLUGIN_ROOT}"],
      envVars: ["PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"]
    },
    dialect: HOOK_DIALECTS.codex
  });
  const output2 = cloneFiles(files);
  const convertedSkills = convertSkillFiles({
    files,
    declared: source.skills,
    output: output2,
    report
  });
  const commandSkills = [];
  for (const path of pathList(source.commands)) {
    const candidates = /\.md$/i.test(path) ? [path] : Array.from(files.keys()).filter(
      (file) => normalizePath(file).startsWith(`${path}/`) && /\.md$/i.test(file)
    );
    if (candidates.length === 0)
      report.blocking.push({
        capability: "commands",
        path,
        message: "declared command paths did not contain Markdown command files",
        blocking: true
      });
    for (const commandPath of candidates) {
      const text = files.get(commandPath);
      if (text === void 0) continue;
      rejectUnsupportedRuntimeTokens({ text, capability: "commands", path: commandPath, report });
      const built = buildSkill(text, [], displayNameFromPath(commandPath));
      for (const message of built.blockers)
        report.blocking.push({ capability: "commands", path: commandPath, message, blocking: true });
      commandSkills.push(built.skill);
      report.converted.push({
        capability: "commands",
        path: commandPath,
        message: `converted command to skill ${built.skill.id} (Codex migrates commands to skills)`,
        blocking: false
      });
    }
  }
  const presets = convertMcpDocuments({
    documents: mcpDocuments(files, source.mcpServers, ".mcp.json"),
    adapterSourceName: "claude-code.json",
    output: output2,
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
  for (const key of ["websiteUrl", "websiteURL"])
    if (interfaceMetadata && !optionalString(source.homepage) && optionalString(interfaceMetadata[key]))
      mappedInterfaceFields.add(key);
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
      skills: [...convertedSkills.skills, ...commandSkills],
      subagents: [],
      presets,
      commandHooks,
      needsFilesystem: convertedSkills.needsFilesystem
    },
    report,
    options: options2
  });
}
function parseGeminiCommand(path, text, report) {
  let parsed;
  try {
    parsed = parse18(text);
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
  const blocking = [
    ["excludeTools", source.excludeTools],
    ["themes", source.themes],
    ["plan", source.plan]
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
      "contextFileName",
      "excludeTools",
      "mcpServers",
      "settings",
      "themes",
      "plan",
      "migratedTo"
    ]),
    sourcePath,
    report
  });
  if (configured(source.migratedTo))
    report.warnings.push({
      capability: "migratedTo",
      path: `${sourcePath}.migratedTo`,
      message: "Gemini update redirection is an install-time concern and was not projected",
      blocking: false
    });
  if (typeof source.name === "string" && !/^[a-zA-Z0-9-]+$/.test(source.name))
    report.warnings.push({
      capability: "name",
      path: `${sourcePath}.name`,
      message: "Gemini extension names must match ^[a-zA-Z0-9-]+$; the host may refuse this extension",
      blocking: false
    });
  const separatorFiles = new Map(files);
  for (const path of [sourcePath, "hooks/hooks.json"]) {
    const text = files.get(path);
    if (text === void 0 || !/\$\{(?:\/|pathSeparator)\}/.test(text)) continue;
    separatorFiles.set(path, text.replaceAll("${/}", "/").replaceAll("${pathSeparator}", "/"));
    report.warnings.push({
      capability: "variables",
      path,
      message: "Gemini ${/} path separators were normalized to /",
      blocking: false
    });
  }
  const geminiSource = separatorFiles.get(sourcePath) === files.get(sourcePath) ? source : parseJsonObject(separatorFiles.get(sourcePath), sourcePath);
  const output2 = cloneFiles(files);
  const convertedSkills = convertSkillFiles({ files, declared: void 0, output: output2, report });
  const skills = [...convertedSkills.skills];
  if (filesBelow(files, "policies").length)
    report.blocking.push({
      capability: "policies",
      path: "policies/",
      message: "Gemini policy engine rules (policies/*.toml) have no Cognia equivalent",
      blocking: true
    });
  const commandHooks = convertHookDocuments({
    documents: collectHookDocuments({
      files: separatorFiles,
      declared: void 0,
      sourcePath,
      report,
      defaultFiles: ["hooks/hooks.json"]
    }),
    report,
    roots: { tokens: ["${extensionPath}"], envVars: [] },
    dialect: HOOK_DIALECTS["gemini-cli"]
  });
  const subagents = [];
  for (const agentPath of Array.from(files.keys()).map(normalizePath).sort()) {
    if (!/^agents\/[^/]+\.md$/i.test(agentPath)) continue;
    const agent = convertMarkdownAgent({
      path: agentPath,
      text: files.get(agentPath),
      id: displayNameFromPath(agentPath),
      label: "Gemini CLI",
      allowedFields: ["name", "description", "maxTurns"],
      defaults: { kind: "local" },
      renames: { max_turns: "maxTurns" },
      report
    });
    if (agent) {
      subagents.push(agent);
      report.warnings.push({
        capability: "agents",
        path: agentPath,
        message: "Gemini extension agents are a preview feature; routing parity must be verified",
        blocking: false
      });
    }
  }
  const contextPaths = typeof source.contextFileName === "string" ? [source.contextFileName] : Array.isArray(source.contextFileName) ? source.contextFileName.filter((entry) => typeof entry === "string") : ["GEMINI.md"];
  for (const [index, contextPath] of contextPaths.entries()) {
    const context = files.get(normalizePath(contextPath));
    if (context !== void 0 && context.trim()) {
      rejectUnsupportedRuntimeTokens({
        text: context,
        capability: "context",
        path: contextPath,
        report
      });
      skills.push({
        id: index === 0 ? "gemini-context" : `gemini-context-${index + 1}`,
        name: index === 0 ? "Gemini Context" : `Gemini Context ${index + 1}`,
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
  }
  for (const path of Array.from(files.keys()).map(normalizePath).sort()) {
    if (!path.startsWith("commands/") || !path.endsWith(".toml")) continue;
    const skill = parseGeminiCommand(path, requiredString(files.get(path), path), report);
    if (skill) skills.push(skill);
  }
  if (report.warnings.some((issue2) => issue2.capability === "commands")) {
    report.fidelity = "contextual";
  }
  const presets = convertMcpDocuments({
    documents: mcpDocuments(files, geminiSource.mcpServers, ""),
    adapterSourceName: "gemini.json",
    output: output2,
    report,
    roots: { tokens: ["${extensionPath}"], envVars: [] }
  });
  importGeminiSettings({ settings: source.settings, presets, source: geminiSource, report });
  return finalizeForeignConversion({
    source: "gemini-cli",
    output: output2,
    metadata: metadataFromForeignManifest(source, sourcePath),
    contributions: {
      skills,
      subagents,
      presets,
      commandHooks,
      needsFilesystem: convertedSkills.needsFilesystem
    },
    report,
    options: options2
  });
}
function importGeminiSettings(args) {
  if (args.settings === void 0) return;
  const fail = (path, message) => args.report.blocking.push({ capability: "settings", path, message, blocking: true });
  if (!Array.isArray(args.settings)) {
    fail("settings", "Gemini settings must be an array");
    return;
  }
  const declarations = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [index, value] of args.settings.entries()) {
    const path = `settings[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(path, "Gemini setting must be an object");
      continue;
    }
    const setting = value;
    const variable = optionalString(setting.envVar);
    const label = optionalString(setting.name);
    if (!variable || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) || !label || seen.has(variable) || Object.keys(setting).some(
      (key) => !["name", "description", "envVar", "sensitive"].includes(key)
    ) || setting.sensitive !== void 0 && typeof setting.sensitive !== "boolean") {
      fail(
        path,
        "Setting has invalid/duplicate environment variable, missing name, or unsupported configuration fields"
      );
      continue;
    }
    seen.add(variable);
    declarations.push({
      path,
      envVar: variable,
      name: label,
      description: optionalString(setting.description),
      sensitive: Boolean(setting.sensitive)
    });
  }
  importInstallSettings({
    declarations,
    presets: args.presets,
    servers: args.source.mcpServers ?? {},
    report: args.report,
    capability: "settings",
    // Gemini also exposes declared settings directly to local server processes.
    exposeToStdio: true
  });
}
function importInstallSettings(args) {
  const fail = (path, message) => args.report.blocking.push({ capability: args.capability, path, message, blocking: true });
  for (const setting of args.declarations) {
    const path = setting.path ?? `${args.capability}.${setting.envVar}`;
    const variable = setting.envVar;
    const label = setting.name;
    const reference = "${" + variable + "}";
    let used = false;
    for (const preset of args.presets) {
      const original = args.servers[preset.id] ?? {};
      const fields = preset.fields ??= [];
      const add = (field) => {
        const existing = fields.findIndex(
          (candidate) => candidate.placement === field.placement && candidate.key === field.key
        );
        const mapped = {
          ...field,
          label,
          ...setting.description ? { description: setting.description } : {},
          secret: setting.sensitive
        };
        if (existing >= 0) fields[existing] = mapped;
        else fields.push(mapped);
        used = true;
      };
      const env = original.env;
      for (const [key, raw] of Object.entries(env ?? {})) {
        if (raw === reference) add({ key, label, placement: "env" });
        else if (typeof raw === "string" && raw.includes(reference))
          fail(
            path,
            `Composed environment binding ${key} cannot be represented by a Cognia preset field`
          );
      }
      const headers = original.headers;
      for (const [key, raw] of Object.entries(headers ?? {})) {
        if (raw === reference) add({ key, label, placement: "header" });
        else if (typeof raw === "string" && raw.includes(reference))
          fail(
            path,
            `Composed header binding ${key} cannot be represented by a Cognia preset field`
          );
      }
      const url = original.httpUrl ?? original.url;
      if (url === reference) add({ key: "url", label, placement: "url" });
      else if (typeof url === "string" && url.includes(reference))
        fail(
          path,
          "Composed URL bindings require a template adapter; conversion cannot replace them with an unrelated full URL"
        );
      if (Array.isArray(original.args) && original.args.some((arg) => typeof arg === "string" && arg.includes(reference)))
        add({ key: variable, label, placement: "arg-replace", token: reference });
      if (args.exposeToStdio && preset.transport === "stdio" && !(variable in (env ?? {}))) {
        preset.config.env = {
          ...preset.config.env ?? {},
          [variable]: ""
        };
        add({ key: variable, label, placement: "env" });
      }
    }
    if (!used)
      args.report.warnings.push({
        capability: args.capability,
        path,
        message: "Setting is not referenced by a converted MCP contribution; no Cognia field was created",
        blocking: false
      });
  }
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
  const token = target === "claude-code" ? "${CLAUDE_PLUGIN_ROOT}" : target === "gemini-cli" ? "${extensionPath}" : "${CLAUDE_PLUGIN_ROOT}";
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
    if (args.target === "gemini-cli" && (skill.invocationPolicy === "explicit" || skill.allowedTools?.length)) {
      args.report.blocking.push({
        capability: "skills",
        path: `skills.${skill.id}`,
        message: "Gemini skill activation and tool approval do not implement Claude invocation/tool controls; export cannot silently loosen them",
        blocking: true
      });
      continue;
    }
    const markdown = skill.source.kind === "inline" ? skill.source.markdown : args.files.get(
      [normalizePath("path" in skill.source ? skill.source.path : ""), "SKILL.md"].filter(Boolean).join("/")
    );
    if (markdown) {
      const built = buildSkill(serializeSkill({ ...skill, content: markdown }), [], skill.name);
      for (const message of built.blockers)
        args.report.blocking.push({
          capability: "skills",
          path: `skills.${skill.id}`,
          message,
          blocking: true
        });
    }
    if (skill.source.kind === "inline") {
      args.output.set(
        `${targetDirectory}/SKILL.md`,
        serializeSkill({
          ...skill,
          content: skill.source.markdown
        })
      );
    } else if (skill.source.kind === "local-folder" || skill.source.kind === "local-bundle") {
      const sourceDirectory = normalizePath(skill.source.path);
      const sourcePrefix = sourceDirectory ? `${sourceDirectory}/` : "";
      const originalMarkdown = args.files.get(`${sourcePrefix}SKILL.md`);
      if (originalMarkdown === void 0) {
        args.report.blocking.push({
          capability: "skills",
          path: sourceDirectory,
          message: `skill bundle ${skill.id} was not found or is missing SKILL.md`,
          blocking: true
        });
        continue;
      }
      const parsedBundle = buildSkill(originalMarkdown, [], skill.name);
      for (const message of parsedBundle.blockers)
        args.report.blocking.push({
          capability: "skills",
          path: `${sourceDirectory}/SKILL.md`,
          message,
          blocking: true
        });
      if (args.target === "gemini-cli" && (parsedBundle.skill.invocationPolicy === "explicit" || parsedBundle.skill.allowedTools?.length))
        args.report.blocking.push({
          capability: "skills",
          path: `${sourceDirectory}/SKILL.md`,
          message: "Gemini cannot enforce the skill's invocation or tool approval controls",
          blocking: true
        });
      const rootFiles = sourceDirectory ? void 0 : new Set(rootSkillFiles(args.files, args.manifest.main));
      const entries = Array.from(args.files.entries()).filter(
        ([path]) => !isPluginEnvironmentFile(path) && (rootFiles ? rootFiles.has(path) : normalizePath(path).startsWith(sourcePrefix))
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
        const relative2 = normalizePath(path).slice(sourcePrefix.length);
        const normalizedSource = normalizePath(path);
        const target = `${targetDirectory}/${relative2}`;
        if (args.binaryPaths?.has(normalizedSource)) {
          args.copies.push({ from: normalizedSource, to: target });
        } else {
          args.output.set(
            target,
            relative2 === "SKILL.md" && parsedBundle.skill.source.kind === "inline" ? serializeSkill({
              ...parsedBundle.skill,
              ...skill,
              content: parsedBundle.skill.source.markdown
            }) : contents
          );
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
  if (args.target !== "claude-code" && args.target !== "gemini-cli") {
    args.report.blocking.push({
      capability: "subagent",
      path: "subagents",
      message: `${args.target} plugins have no subagent contribution; native export is not possible`,
      blocking: true
    });
    return;
  }
  if (args.target === "gemini-cli") {
    for (const agent of subagents) {
      const unsupported = Object.entries({
        provider: agent.provider,
        externalPresetId: agent.externalPresetId,
        mcpServerIds: agent.mcpServerIds?.length,
        allowNesting: agent.allowNesting,
        maxDepth: agent.maxDepth,
        hidden: agent.hidden,
        disabled: agent.disabled,
        tools: agent.tools?.length,
        disallowedTools: agent.disallowedTools?.length,
        model: agent.model,
        effort: agent.effort
      }).filter(([, value]) => configured(value)).map(([key]) => key);
      if (unsupported.length) {
        args.report.blocking.push({
          capability: "subagent",
          path: `subagents.${agent.id}`,
          message: `Gemini extension agents have no exact equivalent for: ${unsupported.join(", ")}`,
          blocking: true
        });
        continue;
      }
      args.output.set(
        `agents/${agent.id}.md`,
        import_gray_matter6.default.stringify(agent.prompt.endsWith("\n") ? agent.prompt : `${agent.prompt}
`, {
          name: agent.id,
          description: agent.description,
          ...agent.maxTurns ? { max_turns: agent.maxTurns } : {}
        })
      );
      args.report.converted.push({
        capability: "subagent",
        path: `subagents.${agent.id}`,
        message: `exported subagent ${agent.id}`,
        blocking: false
      });
      args.report.warnings.push({
        capability: "subagent",
        path: `subagents.${agent.id}`,
        message: "Gemini extension agents are a preview feature; routing parity must be verified",
        blocking: false
      });
    }
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
  const fieldProjection = args.fieldProjection ?? (args.target === "gemini-cli" ? "gemini-settings" : void 0);
  const presets = args.manifest.mcpServerPresets ?? [];
  if (presets.length === 0) return void 0;
  const servers = [];
  for (const preset of presets) {
    const sanitized = sanitizeMcpConfig(preset.transport, preset.config);
    const config = sanitized.config;
    const fields = [...preset.fields ?? []];
    for (const field of sanitized.fields) {
      const container = field.placement === "env" ? "env" : "headers";
      const original = field.placement === "url" ? preset.config.url : field.placement === "arg-replace" ? void 0 : preset.config[container]?.[field.key];
      const binding = typeof original === "string" && /^\$\{[A-Za-z_][A-Za-z0-9_]*\}(?:\/[^\r\n]*)?$/.test(original);
      if (field.placement === "arg-replace") {
        config.args = structuredClone(preset.config.args);
        continue;
      }
      if (field.placement === "env" && !field.secret || binding) {
        if (field.placement === "url") config.url = original;
        else
          config[container] = {
            ...config[container] ?? {},
            [field.key]: original
          };
        continue;
      }
      if (typeof original === "string" && original) args.removedValues.add(original);
      if (!fields.some(
        (existing) => existing.key === field.key && existing.placement === field.placement
      ))
        fields.push(field);
    }
    const hostFields = [
      "excludeTools",
      "includeTools",
      "disabled",
      "enabled",
      "trust",
      "autoApprove"
    ].filter((field) => config[field] !== void 0);
    if (hostFields.length)
      args.report.blocking.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}`,
        message: `Host-specific MCP policy requires a target enforcement adapter: ${hostFields.join(", ")}`,
        blocking: true
      });
    if (preset.defaultDisallowedTools?.length || preset.toolRiskRules?.length || preset.provisioning?.mode === "managed" || preset.runtime && preset.runtime !== "both") {
      args.report.blocking.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}`,
        message: "Cognia tool restrictions, runtime routing, managed provisioning, and risk policy require host enforcement; native export cannot drop them",
        blocking: true
      });
      continue;
    }
    if (fields.length && !fieldProjection) {
      args.report.blocking.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}.fields`,
        message: `${args.target} installation configuration projection is not implemented; configure the preset or use Cognia hosting`,
        blocking: true
      });
      continue;
    }
    for (const field of fields) {
      const variable = `COGNIA_${preset.id}_${field.key}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      if (args.settings.some((setting) => setting.envVar === variable)) {
        args.report.blocking.push({
          capability: "mcp-server-preset",
          path: `mcpServerPresets.${preset.id}.fields`,
          message: "Configuration fields collide after environment-variable normalization",
          blocking: true
        });
        continue;
      }
      const reference = "${" + variable + "}";
      if (field.placement === "env" || field.placement === "header") {
        const key = field.placement === "env" ? "env" : "headers";
        config[key] = {
          ...config[key] ?? {},
          [field.key]: reference
        };
      } else if (field.placement === "url") {
        config.url = reference;
      } else if (field.placement === "arg-replace" && field.token && Array.isArray(config.args) && config.args.some((arg) => typeof arg === "string" && arg.includes(field.token))) {
        config.args = config.args.map(
          (arg) => typeof arg === "string" ? arg.replaceAll(field.token, reference) : arg
        );
      } else {
        args.report.blocking.push({
          capability: "mcp-server-preset",
          path: `mcpServerPresets.${preset.id}.fields.${field.key}`,
          message: "Invalid configuration placement or missing argument replacement token",
          blocking: true
        });
        continue;
      }
      args.settings.push({
        name: field.label,
        description: field.description ?? field.label,
        envVar: variable,
        sensitive: Boolean(field.secret)
      });
    }
    if (fields.length)
      args.report.warnings.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}.fields`,
        message: fieldProjection === "cursor-variables" ? "Cursor declares these as plugin variables; an administrator sets the values in the Cursor dashboard before use" : "Gemini requests these settings during installation; values must be supplied before use",
        blocking: false
      });
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
      config: replaceCanonicalRootToken(config, args.target),
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
function exportCommandHooks(args) {
  const hooks = args.manifest.commandHooks;
  if (!hooks || !Object.keys(hooks).length) return;
  const dialect = args.target === "claude-code" ? void 0 : args.target === "codex" ? HOOK_DIALECTS.codex : args.target === "gemini-cli" ? HOOK_DIALECTS["gemini-cli"] : null;
  if (dialect === null) {
    args.report.blocking.push({
      capability: "command-hooks",
      path: "commandHooks",
      message: `${args.target} hooks are not declarative; native export is not possible`,
      blocking: true
    });
    return;
  }
  const validated = convertHookDocuments({
    documents: [{ path: "commandHooks", value: { hooks } }],
    report: args.report
  });
  if (dialect) {
    const projected = canonicalHooksToDialect({
      hooks: validated,
      dialect,
      sink: args.report,
      path: "hooks/hooks.json"
    });
    if (projected)
      args.output.set(
        "hooks/hooks.json",
        JSON.stringify(replaceCanonicalRootToken(projected, args.target), null, 2) + "\n"
      );
    return;
  }
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups ?? []) {
      if (group.agents)
        args.report.blocking.push({
          capability: "command-hooks",
          path: `commandHooks.${event}`,
          message: "Claude Code cannot enforce Cognia agent selectors",
          blocking: true
        });
      for (const handler of group.hooks) {
        if (!["command", "http", "prompt", "agent", "mcp_tool"].includes(handler.type) || handler.policyClass === "managed") {
          args.report.blocking.push({
            capability: "command-hooks",
            path: `commandHooks.${event}`,
            message: "Cognia-only hook handlers and managed fail-closed policies require the Cognia host",
            blocking: true
          });
        }
      }
    }
  }
  args.output.set(
    "hooks/hooks.json",
    JSON.stringify(replaceCanonicalRootToken({ hooks: validated }, args.target), null, 2) + "\n"
  );
}
function exportRuntimeResources(args) {
  const strings = [];
  const collectStrings = (value) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) value.forEach(collectStrings);
    else if (value && typeof value === "object") Object.values(value).forEach(collectStrings);
  };
  collectStrings([args.manifest.mcpServerPresets, args.manifest.commandHooks]);
  if (!strings.some((value) => value.includes("${COGNIA_PLUGIN_ROOT}"))) return;
  const payloadPaths = new Set(args.files.keys());
  for (const path of args.files.keys()) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length++)
      payloadPaths.add(segments.slice(0, length).join("/"));
  }
  const candidates = [...payloadPaths].sort((a, b) => b.length - a.length);
  const references = [];
  for (const value of strings) {
    for (const match of value.matchAll(/\$\{COGNIA_PLUGIN_ROOT\}\//g)) {
      const suffix = value.slice(match.index + match[0].length);
      const known = candidates.find(
        (path) => suffix.startsWith(path) && (!suffix[path.length] || /[\s"'`;)]/.test(suffix[path.length]))
      );
      references.push(known ?? suffix.split(/["'`\r\n]/)[0]);
    }
  }
  for (const reference of references) {
    const path = normalizePath(reference);
    if (!args.files.has(path) && !filesBelow(args.files, path).length)
      args.report.blocking.push({
        capability: "resources",
        path,
        message: "Plugin-relative executable or resource reference is missing from the bundle",
        blocking: true
      });
  }
  for (const [path, text] of args.files) {
    if (path === "plugin.json" || path === args.manifest.main || VENDOR_MANIFEST_PATHS.includes(path) || path === "mcp.json" || /^\.cognia-normalized\//.test(path) || /^\.(?:claude|codex)-plugin\//.test(path) || /(^|\/)\.env(?:\.|$)/.test(path) || path === ".mcp.json" || path === "hooks/hooks.json" || path === "hooks.json")
      continue;
    if (path.startsWith("skills/") && path.endsWith("/SKILL.md") || /^(?:agents|droids)\//.test(path) && path.endsWith(".md") || path.startsWith("commands/") && /\.(?:toml|md)$/.test(path) || path.startsWith("policies/") || path.startsWith("output-styles/") || path.startsWith("workflows/") || path === ".lsp.json" || path === "settings.json")
      continue;
    if (args.output.has(path)) continue;
    if (args.binaryPaths?.has(path)) args.copies.push({ from: path, to: path });
    else args.output.set(path, replaceCanonicalRootToken(text, args.target));
  }
  for (const reference of references) {
    const path = normalizePath(reference);
    if (!args.output.has(path) && !filesBelow(args.output, path).length && !args.copies.some((copy) => copy.to === path || copy.to.startsWith(`${path}/`)))
      args.report.blocking.push({
        capability: "resources",
        path,
        message: "Referenced resource is excluded or relocated in this target bundle; update the reference before exporting",
        blocking: true
      });
  }
  args.report.warnings.push({
    capability: "resources",
    path: ".",
    message: "Bundled runtime payload and dependency manifests preserved; executable installation and runtime availability require target-host verification",
    blocking: false
  });
}
function authorForForeign(manifest) {
  if (!manifest.author) return void 0;
  return {
    name: manifest.author.name,
    ...manifest.author.email ? { email: manifest.author.email } : {},
    ...manifest.author.url ? { url: manifest.author.url } : {}
  };
}
var PROJECTED_SETTINGS = /* @__PURE__ */ new WeakMap();
function convertCogniaPlugin(files, target, options2, context = {}) {
  const loaded = loadCogniaPlugin(files);
  const manifest = loaded.manifest;
  const finalTarget = context.finalTarget ?? target;
  const report = {
    fidelity: "structured",
    converted: [],
    warnings: [],
    blocking: []
  };
  const allowedCapabilities = /* @__PURE__ */ new Set([
    "skills",
    "mcp-server-preset",
    "command-hooks",
    ...target === "claude-code" || target === "gemini-cli" ? ["subagent"] : [],
    ...target === "pi" ? ["pi-package"] : []
  ]);
  for (const capability of manifest.capabilities ?? []) {
    if (allowedCapabilities.has(capability)) continue;
    if (capability === "pi-package")
      report.blocking.push({
        capability,
        path: "piPackages",
        message: `Pi packages install only into Pi (pi install) or load into Cognia-hosted Pi sessions; they stay in Cognia and have no ${finalTarget} equivalent`,
        blocking: true
      });
    else report.blocking.push(unsupportedIssue(capability, finalTarget));
  }
  if (manifest.permissions?.length) {
    report.blocking.push(unsupportedIssue("permissions", finalTarget));
  }
  const executableEntries = [manifest.pythonMain, manifest.wasmMain, manifest.vscodeMain].filter(
    configured
  );
  if (executableEntries.length > 0) {
    report.blocking.push(unsupportedIssue("runtime", finalTarget));
  }
  if (manifest.main) {
    const entry = files.get(normalizePath(manifest.main));
    if (entry !== renderDist(manifest)) {
      report.blocking.push({
        capability: "runtime",
        path: manifest.main,
        message: "imperative Cognia activation code cannot be translated declaratively",
        blocking: true
      });
    }
  }
  if (target === "pi") return exportPiPackage({ manifest, files, report, options: options2 });
  if (target === "claude-code" && finalTarget === "claude-code") {
    const { nameRule, reservedNames } = CLAUDE_FAMILY_PROFILES["claude-code"];
    for (const rule of [nameRule, reservedNames])
      if (rule && rule.pattern.test(manifest.id) !== (rule === nameRule))
        report.blocking.push({
          capability: "name",
          path: "id",
          message: rule.message,
          blocking: true
        });
  }
  if (target === "gemini-cli" && !/^[a-zA-Z0-9-]+$/.test(manifest.id))
    report.blocking.push({
      capability: "name",
      path: "id",
      message: "Gemini extension names must match ^[a-zA-Z0-9-]+$",
      blocking: true
    });
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
  const settings = [];
  const removedValues = /* @__PURE__ */ new Set();
  const mcp = exportMcpServers({
    manifest,
    output: output2,
    target,
    report,
    settings,
    removedValues,
    fieldProjection: context.fieldProjection
  });
  exportCommandHooks({ manifest, output: output2, target, report });
  exportRuntimeResources({
    manifest,
    files,
    output: output2,
    copies,
    target,
    report,
    binaryPaths: options2.binaryPaths
  });
  for (const [path, text] of output2) {
    if ([...removedValues].some((value) => text.includes(value)))
      report.blocking.push({
        capability: "secrets",
        path,
        message: "A removed MCP credential is also present in an exported resource",
        blocking: true
      });
  }
  if (report.blocking.length > 0) {
    report.fidelity = "unsupported";
    throw new UnsupportedPluginConversionError("cognia", finalTarget, report);
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
          ...output2.has("hooks/hooks.json") ? { hooks: "./hooks/hooks.json" } : {},
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
    output2.set(
      "gemini-extension.json",
      `${JSON.stringify(
        {
          name: manifest.id,
          version: manifest.version,
          description: manifest.description,
          ...geminiServers ? { mcpServers: geminiServers } : {},
          ...settings.length ? { settings } : {}
        },
        null,
        2
      )}
`
    );
  }
  const result = {
    source: "cognia",
    target,
    manifest,
    files: output2,
    copies,
    report
  };
  if (context.fieldProjection && settings.length) PROJECTED_SETTINGS.set(result, settings);
  return result;
}
function exportPiPackage(args) {
  const { manifest, files, report, options: options2 } = args;
  if (manifest.mcpServerPresets?.length)
    report.blocking.push({
      capability: "mcp-server-preset",
      path: "mcpServerPresets",
      message: "Pi core has no declarative MCP servers; an extension must call pi.registerMcpServer. Select hosted use or ship a Pi extension",
      blocking: true
    });
  if (manifest.commandHooks && Object.keys(manifest.commandHooks).length)
    report.blocking.push({
      capability: "command-hooks",
      path: "commandHooks",
      message: "Pi hooks are extension event handlers (pi.on); a declarative command hook cannot become one",
      blocking: true
    });
  let skills = manifest.skills ?? [];
  const packages = manifest.piPackages ?? [];
  if (packages.length === 1) {
    const classified = classifySkillsForPiPackage({
      skills,
      files,
      piPackage: packages[0]
    });
    report.blocking.push(...classified.collisions);
    for (const id of classified.delivered)
      report.converted.push({
        capability: "skills",
        path: `skills.${id}`,
        message: `skill ${id} is delivered by the retained Pi package`,
        blocking: false
      });
    skills = classified.remaining;
  }
  const exported = /* @__PURE__ */ new Map();
  const exportedCopies = [];
  exportCogniaSkills({
    manifest: { ...manifest, skills },
    files,
    output: exported,
    target: "pi",
    report,
    copies: exportedCopies,
    binaryPaths: options2.binaryPaths
  });
  const probe = new Map(exported);
  for (const copy of exportedCopies) if (!probe.has(copy.to)) probe.set(copy.to, "");
  const semantics = checkSkillSemantics(probe, "pi", "export");
  report.blocking.push(...semantics.blocking);
  report.warnings.push(...semantics.warnings);
  const plan = planPiExport({
    manifest,
    files,
    exported,
    exportedCopies,
    binaryPaths: options2.binaryPaths,
    generatedEntry: renderDist(manifest)
  });
  report.converted.push(...plan.issues.converted);
  report.warnings.push(...plan.issues.warnings);
  report.blocking.push(...plan.issues.blocking);
  if (report.blocking.length > 0) {
    report.fidelity = "unsupported";
    throw new UnsupportedPluginConversionError("cognia", "pi", report);
  }
  report.warnings.push({
    capability: "compatibility",
    path: "package.json",
    message: "Native Pi installation and execution require separate verification",
    blocking: false
  });
  return {
    source: "cognia",
    target: "pi",
    manifest,
    files: plan.files,
    copies: plan.copies,
    report
  };
}
function convertPiPlugin(files, options2) {
  const plan = planPiImport(files);
  const report = {
    fidelity: plan.contextual ? "contextual" : "structured",
    converted: [...plan.issues.converted],
    warnings: [...plan.issues.warnings],
    blocking: [...plan.issues.blocking]
  };
  const semantics = checkSkillSemantics(
    files,
    "pi",
    "import",
    plan.skillFiles.filter((path) => /(^|\/)SKILL\.md$/.test(path))
  );
  report.blocking.push(...semantics.blocking);
  report.warnings.push(...semantics.warnings);
  if (report.blocking.length > 0) {
    report.fidelity = "unsupported";
    throw new UnsupportedPluginConversionError("pi", "cognia", report);
  }
  const output2 = cloneFiles(files);
  const converted = convertSkillFiles({
    files,
    declared: void 0,
    output: output2,
    report,
    explicit: plan.skillFiles
  });
  const skills = [...converted.skills];
  for (const prompt of plan.promptSkills) {
    if (skills.some((skill) => skill.id === prompt.id)) {
      report.blocking.push({
        capability: "prompts",
        path: `prompts.${prompt.id}`,
        message: `Pi prompt /${prompt.name} and a Pi skill both become Cognia skill ${prompt.id}`,
        blocking: true
      });
      continue;
    }
    skills.push(prompt);
  }
  for (const path of files.keys())
    if (isPluginEnvironmentFile(path))
      report.warnings.push({
        capability: "secrets",
        path,
        message: "Environment files inside the Pi package are blanked; credentials are never copied",
        blocking: false
      });
  return finalizeForeignConversion({
    source: "pi",
    output: output2,
    metadata: metadataFromForeignManifest(plan.metadata, "package.json"),
    contributions: {
      skills,
      subagents: [],
      presets: [],
      piPackages: [plan.piPackage],
      needsFilesystem: true
    },
    report,
    options: options2,
    retainSourceManifests: true
  });
}
var NORMALIZED_PROFILE = {
  ...CLAUDE_FAMILY_PROFILES["claude-code"],
  ignoredFields: {},
  blockedFields: {},
  unknownFields: "block",
  blockedPaths: [],
  requireDotSlashPaths: false,
  nameRule: { pattern: /[\s\S]*/, message: "" }
};
var ECOSYSTEM_LABELS = {
  cognia: "Cognia",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  "agent-plugins": "Agent Plugins",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
  kimi: "Kimi CLI",
  devin: "Devin",
  opencode: "OpenCode",
  pi: "Pi",
  "factory-droid": "Factory Droid",
  qoder: "Qoder CLI",
  codebuddy: "CodeBuddy",
  auggie: "Auggie",
  "open-plugins": "Open Plugins"
};
function isClaudeFamily(value) {
  return value in CLAUDE_FAMILY_PROFILES;
}
function convertPluginBundle(files, target, options2 = {}) {
  for (const path of files.keys()) {
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\") || path.split("/").includes("..")) {
      throw new Error(`plugin source path must stay relative to the bundle: ${path}`);
    }
  }
  const detected = detectPluginBundle(files);
  const source = detected.ecosystem;
  const shadowWarnings = detected.shadowed.map((entry) => ({
    capability: "format",
    path: entry.path,
    message: `${ECOSYSTEM_LABELS[entry.ecosystem]} manifest is also present; this conversion reads ${detected.manifestPath} (${ECOSYSTEM_LABELS[source]}) and does not convert it`,
    blocking: false
  }));
  let canonical;
  const platformTarget = (value) => value in PLATFORM_BUNDLE_PROFILES;
  const finish = (result) => {
    result.source = source;
    result.target = target;
    result.report.delivery = assessPluginDelivery({
      manifest: canonical?.manifest ?? result.manifest,
      report: result.report,
      target
    });
    return result;
  };
  try {
    if (source === "cognia") canonical = loadCogniaPlugin(files);
    else if (isClaudeFamily(source))
      canonical = convertClaudePlugin(files, options2, CLAUDE_FAMILY_PROFILES[source]);
    else if (source === "codex") canonical = convertCodexPlugin(files, options2);
    else if (source === "gemini-cli") canonical = convertGeminiPlugin(files, options2);
    else if (source === "pi") canonical = convertPiPlugin(files, options2);
    else {
      const normalized = normalizePlatformBundle(files, source);
      if (normalized.blocking.length)
        throw new UnsupportedPluginConversionError(source, target, {
          fidelity: "unsupported",
          converted: [],
          warnings: [...shadowWarnings, ...normalized.warnings],
          blocking: normalized.blocking
        });
      canonical = convertClaudePlugin(normalized.files, options2, NORMALIZED_PROFILE, {
        explicitSkills: normalized.skills ?? [],
        hookDefaults: false,
        mcpMode: "replace",
        settings: normalized.settings,
        rootSkillResources: normalized.rootSkillResources
      });
      for (const path of normalized.transient) canonical.files.delete(path);
      canonical.copies = canonical.copies.filter((copy) => !normalized.transient.has(copy.to));
      canonical.report.warnings.unshift(...normalized.warnings);
    }
    canonical.report.warnings.unshift(...shadowWarnings);
    if (target === "cognia") {
      if (source !== "cognia")
        for (const [path, text] of canonical.files) {
          const original = files.get(path);
          if (original === void 0 || original === text) continue;
          if (!isOverlayEntryAllowed(files, path, text)) canonical.files.set(path, original);
        }
      return finish(canonical);
    }
    const exportTarget = platformTarget(target) || isClaudeFamily(target) && target !== "claude-code" ? "claude-code" : target;
    const result = convertCogniaPlugin(canonical.files, exportTarget, options2, {
      finalTarget: target,
      fieldProjection: target === "cursor" ? "cursor-variables" : void 0
    });
    result.report.warnings.unshift(...canonical.report.warnings);
    if (exportTarget === "claude-code" && target !== "claude-code") {
      const nativeFiles = new Map(result.files);
      for (const copy of result.copies) if (!nativeFiles.has(copy.to)) nativeFiles.set(copy.to, "");
      const projected = platformTarget(target) ? projectPlatformBundle(nativeFiles, target, {
        variables: (PROJECTED_SETTINGS.get(result) ?? []).map((setting) => ({
          envVar: String(setting.envVar),
          name: String(setting.name),
          description: typeof setting.description === "string" ? setting.description : void 0,
          sensitive: Boolean(setting.sensitive)
        }))
      }) : projectClaudeFamilyBundle(
        nativeFiles,
        CLAUDE_FAMILY_PROFILES[target]
      );
      result.report.warnings.push(...projected.warnings);
      result.report.blocking.push(...projected.blocking);
      if (projected.blocking.length) {
        result.report.fidelity = "unsupported";
        throw new UnsupportedPluginConversionError(source, target, result.report);
      }
      const relocated = /* @__PURE__ */ new Map();
      for (const copy of result.copies) {
        const to = target === "opencode" && copy.to.startsWith("skills/") ? `.opencode/${copy.to}` : target === "kimi" && /^skills\/[^/]+\//.test(copy.to) ? copy.to.replace(/^skills\/[^/]+\//, "") : copy.to;
        relocated.set(copy.to, to);
      }
      result.files = projected.files;
      result.copies = result.copies.map((copy) => ({
        ...copy,
        to: relocated.get(copy.to) ?? copy.to
      }));
      for (const copy of result.copies) result.files.delete(copy.to);
    }
    return finish(result);
  } catch (error) {
    if (!(error instanceof UnsupportedPluginConversionError)) throw error;
    const report = { ...error.report, fidelity: "unsupported" };
    if (!report.warnings.some((issue2) => shadowWarnings.includes(issue2)))
      report.warnings = [...shadowWarnings, ...report.warnings];
    report.delivery = assessPluginDelivery({ manifest: canonical?.manifest, report, target });
    throw new UnsupportedPluginConversionError(source, target, report);
  }
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
var ECOSYSTEM_TARGETS = PLUGIN_ECOSYSTEMS;
var BUNDLE_TEXT_PATTERN = /\.(?:md|markdown|txt|json|jsonc|toml|ya?ml|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rs|css|html)$/i;
function parseEcosystemArgs(argv) {
  const allowed = /* @__PURE__ */ new Set(["--operation", "--from", "--input", "--to", "--dir", "--surface"]);
  const values = /* @__PURE__ */ new Map();
  let dryRun = false;
  let acceptWarnings = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag === "--accept-warnings") {
      acceptWarnings = true;
      continue;
    }
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
    throw new Error(
      `plugin export requires --to ${ECOSYSTEM_TARGETS.filter((target2) => target2 !== "cognia").join(", ")}`
    );
  }
  const surface = values.get("--surface") ?? "cli";
  if (!["cli", "desktop", "cloud"].includes(surface))
    throw new Error("--surface must be cli, desktop, or cloud");
  return {
    operation,
    input,
    target,
    dir: values.get("--dir"),
    dryRun,
    acceptWarnings,
    surface
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
  let result;
  try {
    result = convertPluginBundle(files, args.target, { binaryPaths });
    if (args.surface === "cloud" && args.target !== "cognia") {
      throw new UnsupportedPluginConversionError(result.source, args.target, {
        fidelity: "unsupported",
        converted: [],
        warnings: [],
        blocking: [
          {
            capability: "surface",
            path: "cloud",
            message: "Cloud installation and execution have not been verified. Use a local CLI or desktop target.",
            blocking: true
          }
        ]
      });
    }
  } catch (error) {
    if (!(error instanceof UnsupportedPluginConversionError)) throw error;
    const manifest = detectPluginEcosystem(files) === "cognia" ? convertPluginBundle(files, "cognia", { binaryPaths }).manifest : void 0;
    error.report.delivery = assessPluginDelivery({
      manifest,
      report: error.report,
      target: args.target,
      surface: args.surface
    });
    if (!args.dryRun) throw error;
    return { ok: true, mode: "inspect", files: [], report: error.report };
  }
  result.report.delivery = assessPluginDelivery({
    manifest: result.manifest,
    report: result.report,
    target: args.target,
    surface: args.surface
  });
  const defaultDir = args.operation === "import" ? result.manifest.id : `${result.manifest.id}-${args.target}`;
  const outputDir = io.resolve(args.dir ?? defaultDir);
  const normalizeDirectory = (path) => path.replaceAll("\\", "/").replace(/\/+$/, "");
  const sourcePath = normalizeDirectory(sourceRoot);
  const outputPath = normalizeDirectory(outputDir);
  if (sourcePath === outputPath || outputPath.startsWith(`${sourcePath}/`) || sourcePath.startsWith(`${outputPath}/`)) {
    throw new Error("source and output directories must not overlap");
  }
  if (args.dryRun) {
    return {
      ok: true,
      mode: "inspect",
      pluginId: result.manifest.id,
      dir: outputDir,
      files: [.../* @__PURE__ */ new Set([...result.files.keys(), ...result.copies.map((copy) => copy.to)])].sort(),
      report: result.report
    };
  }
  if (result.report.warnings.length && !args.acceptWarnings) {
    throw new UnsupportedPluginConversionError(result.source, result.target, {
      ...result.report,
      blocking: [
        {
          capability: "review",
          path: "--accept-warnings",
          message: "Inspect with --dry-run, then acknowledge the conversion warnings with --accept-warnings before writing.",
          blocking: true
        }
      ]
    });
  }
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
    warnings: result.report.warnings.map((issue2) => `${issue2.path}: ${issue2.message}`),
    report: result.report
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
    const manifestPath2 = io.join(intoDir, "plugin.json");
    if (!io.exists(manifestPath2)) {
      throw new Error(`${manifestPath2} not found \u2014 --into expects an existing plugin directory`);
    }
    const result2 = convert(input, {
      hostVersion: args.hostVersion,
      gitAuthor: io.gitAuthor(),
      existingManifestText: io.readFile(manifestPath2),
      existingManifestPath: manifestPath2
    });
    io.writeFile(manifestPath2, result2.files.get("plugin.json"));
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
    return {
      output: JSON.stringify({
        ok: false,
        error: message,
        ...err instanceof UnsupportedPluginConversionError ? { report: err.report } : {}
      }),
      exitCode: 1
    };
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
