var domainOptions = systemOptions.register(new OptionSet("Domain Options"));
var traceClasses = domainOptions.register(new Option("tc", "traceClasses", "boolean", false, "trace class creation"));
var traceDomain = domainOptions.register(new Option("tdpa", "traceDomain", "boolean", false, "trace domain property access"));

const ALWAYS_INTERPRET = 0x1;
const HEURISTIC_JIT = 0x2;

var Domain = (function () {

  function Domain(vm, base, mode, allowNatives) {

    this.vm = vm;

    // ABCs that belong to this domain.
    this.abcs = [];

    // Classes that have been loaded.
    this.loadedClasses = [];

    // Classes cache.
    this.cache = {};

    // Our parent.
    this.base = base;

    // Do we allow natives?
    this.allowNatives = allowNatives;

    // Do we compile or interpret?
    this.mode = mode;

    // If we are the system domain (the root), we should initialize the Class
    // and MethodClosure classes.
    if (base) {
      this.system = base.system;
    } else {
      this.system = this;

      var Class = this.Class = function Class(name, instance, callable) {
        this.debugName = name;

        if (instance) {
          assert(instance.prototype);
          this.instance = instance;
        }

        if (!callable) {
          callable = Domain.passthroughCallable(instance);
        }
        defineNonEnumerableProperty(this, "call", callable.call);
        defineNonEnumerableProperty(this, "apply", callable.apply);
      };

      Class.prototype = {
        extendBuiltin: function(baseClass) {
          // Some natives handle their own prototypes/it's impossible to do the
          // traits/public prototype BS, e.g. Object, Array, etc.
          // FIXME: This is technically non-semantics preserving.
          this.baseClass = baseClass;
          this.dynamicPrototype = this.instance.prototype;
          defineNonEnumerableProperty(this.dynamicPrototype, "public$constructor", this);
        },

        extend: function (baseClass) {
          this.baseClass = baseClass;
          this.dynamicPrototype = Object.create(baseClass.dynamicPrototype);
          this.instance.prototype = Object.create(this.dynamicPrototype);
          defineNonEnumerableProperty(this.dynamicPrototype, "public$constructor", this);
        },

        isInstance: function (value) {
          if (value === null || typeof value !== "object") {
            return false;
          }
          return this.dynamicPrototype.isPrototypeOf(value);
        },

        toString: function () {
          return "[class " + this.debugName + "]";
        }
      };

      Class.instance = Class;
      Class.toString = Class.prototype.toString;

      // Traits are below the dynamic instant prototypes,
      // i.e. this.dynamicPrototype === Object.getPrototypeOf(this.instance.prototype)
      // and we cache the dynamic instant prototype as this.dynamicPrototype.
      //
      // Traits are not visible to the AVM script.
      Class.nativeMethods = {
        "get prototype": function () {
          return this.dynamicPrototype;
        }
      };

      var MethodClosure = this.MethodClosure = function MethodClosure($this, fn) {
        var bound = fn.bind($this);
        defineNonEnumerableProperty(this, "call", bound.call.bind(bound));
        defineNonEnumerableProperty(this, "apply", bound.apply.bind(bound));
      };

      MethodClosure.prototype = {
        toString: function () {
          return "function Function() {}";
        }
      };
    }
  }

  Domain.passthroughCallable = function passthroughCallable(f) {
    return {
      call: function ($this) {
        Array.prototype.shift.call(arguments);
        return f.apply($this, arguments);
      },
      apply: function ($this, args) {
        return f.apply($this, args);
      }
    };
  };

  Domain.constructingCallable = function constructingCallable(instance) {
    return {
      call: function ($this) {
        return new Function.bind.apply(instance, arguments);
      },
      apply: function ($this, args) {
        return new Function.bind.apply(instance, [$this].concat(args));
      }
    };
  };

  function executeScript(abc, script) {
    if (disassemble.value) {
      abc.trace(new IndentingWriter());
    }
    if (traceExecution.value) {
      print("Executing: " + abc.name);
    }
    assert(!script.executing && !script.executed);
    script.executing = true;
    abc.runtime.createFunction(script.init, null).call(script.global);
    script.executed = true;
  }

  function ensureScriptIsExecuted(abc, script) {
    if (!script.executed && !script.executing) {
      executeScript(abc, script);
    }
  }

  Domain.prototype = {
    getProperty: function getProperty(multiname, strict, execute) {
      var resolved = this.findDefiningScript(multiname, execute);
      if (resolved) {
        return resolved.script.global[resolved.name.getQualifiedName()];
      }
      if (strict) {
        return unexpected("Cannot find property " + multiname);
      }

      return undefined;
    },

    getClass: function getClass(simpleName) {
      var cache = this.cache;
      var c = cache[simpleName];
      if (!c) {
        c = cache[simpleName] = this.getProperty(Multiname.fromSimpleName(simpleName), true, true);
      }
      assert(c instanceof this.system.Class);
      return c;
    },

    findProperty: function findProperty(multiname, strict, execute) {
      if (traceDomain.value) {
        print("Domain.findProperty: " + multiname);
      }
      var resolved = this.findDefiningScript(multiname, execute);
      if (resolved) {
        return resolved.script.global;
      }
      if (strict) {
        return unexpected("Cannot find property " + multiname);
      } else {
        return undefined;
      }
      return undefined;
    },

    /**
     * Find the first script that defines a multiname.
     *
     * ABCs are added to the list in load order, so a later loaded ABC with a
     * definition of conflicting name will never be resolved.
     */
    findDefiningScript: function findDefiningScript(multiname, execute) {
      if (this.base) {
        var resolved = this.base.findDefiningScript(multiname, execute);
        if (resolved) {
          return resolved;
        }
      }

      var abcs = this.abcs;
      for (var i = 0, j = abcs.length; i < j; i++) {
        var abc = abcs[i];
        var scripts = abc.scripts;
        for (var k = 0, l = scripts.length; k < l; k++) {
          var script = scripts[k];
          if (!script.loaded) {
            continue;
          }
          var global = script.global;
          if (multiname.isQName()) {
            if (multiname.getQualifiedName() in global) {
              if (traceDomain.value) {
                print("Domain.findDefiningScript(" + multiname + ") in " + abc + ", script: " + k);
                print("Script is executed ? " + script.executed + ", should we: " + execute + " is it in progress: " + script.executing);
                print("Value is: " + script.global[multiname.getQualifiedName()]);
              }
              if (execute) {
                ensureScriptIsExecuted(abc, script);
              }
              return { script: script, name: multiname };
            }
          } else {
            var resolved = resolveMultiname(global, multiname);
            if (resolved) {
              if (execute) {
                ensureScriptIsExecuted(abc, script);
              }
              return { script: script, name: resolved };
            }
          }
        }
      }
      return undefined;
    },

    executeAbc: function executeAbc(abc) {
      this.loadAbc(abc);
      executeScript(abc, abc.lastScript);
      if (traceClasses.value) {
        this.traceLoadedClasses();
      }
    },

    loadAbc: function loadAbc(abc) {
      if (traceExecution.value) {
        print("Loading: " + abc.name);
      }

      abc.domain = this;
      var runtime = new Runtime(abc);
      abc.runtime = runtime;

      /**
       * Initialize all the scripts inside the abc block and their globals in
       * reverse order, since some content depends on the last script being
       * initialized first or some shit.
       */
      var scripts = abc.scripts;
      var allowNatives = this.allowNatives;
      for (var i = scripts.length - 1; i >= 0; i--) {
        var script = scripts[i];
        var global = new Global(runtime, script);

        if (allowNatives) {
          global.public$unsafeJSNative = getNative;
        }
      }

      this.abcs.push(abc);
    },

    traceLoadedClasses: function () {
      var writer = new IndentingWriter();
      function traceProperties(obj) {
        for (var key in obj) {
          var str = key;
          var descriptor = Object.getOwnPropertyDescriptor(obj, key);
          if (descriptor) {
            if (descriptor.get) {
              str += " getter";
            }
            if (descriptor.set) {
              str += " setter";
            }
            if (descriptor.value) {
              var value = obj[key];
              if (value instanceof Scope) {
                str += ": ";
                var scope = value;
                while (scope) {
                  assert (scope.object);
                  str += scope.object.debugName || "T";
                  if (scope = scope.parent) {
                    str += " <: ";
                  };
                }
              } else if (value instanceof Function) {
                str += ": " + (value.name ? value.name : "anonymous");
              } else if (value) {
                str += ": " + value;
              }
            }
          }
          writer.writeLn(str);
        }
      }
      writer.enter("Loaded Classes");
      this.loadedClasses.forEach(function (cls) {
        var description = cls.debugName + (cls.baseClass ? " extends " + cls.baseClass.debugName : "");
        writer.enter(description + " {");
        writer.enter("instance");
        traceProperties(cls.prototype);
        writer.leave("");
        writer.enter("static");
        traceProperties(cls);
        writer.leave("");
        writer.leave("}");
      });
      writer.leave("");
    }
  };

  return Domain;

})();