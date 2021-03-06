'use strict'

/* eslint-disable no-console */

// Inspired by the awesome work by the Apollo team: 😘
// https://github.com/apollographql/react-apollo/blob/master/src/getDataFromTree.ts
//
// This version has been adapted to be Promise based and support native Preact.

var defaultOptions = {
  componentWillUnmount: false,
}

var forwardRefSymbol = Symbol.for('react.forward_ref')

// Lifted from https://github.com/sindresorhus/p-reduce
// Thanks @sindresorhus! 🙏
var pReduce = function pReduce(iterable, reducer, initVal) {
  return new Promise(function(resolve, reject) {
    var iterator = iterable[Symbol.iterator]()
    var i = 0

    var next = function next(total) {
      var el = iterator.next()

      if (el.done) {
        resolve(total)
        return
      }

      Promise.all([total, el.value])
        .then(function(value) {
          // eslint-disable-next-line no-plusplus
          next(reducer(value[0], value[1], i++))
        })
        .catch(reject)
    }

    next(initVal)
  })
}

// Lifted from https://github.com/sindresorhus/p-map-series
// Thanks @sindresorhus! 🙏
var pMapSeries = function pMapSeries(iterable, iterator) {
  var ret = []

  return pReduce(iterable, function(a, b, i) {
    return Promise.resolve(iterator(b, i)).then(function(val) {
      ret.push(val)
    })
  }).then(function() {
    return ret
  })
}

var ensureChild = function ensureChild(child) {
  return child && typeof child.render === 'function'
    ? ensureChild(child.render())
    : child
}

// Preact puts children directly on element, and React via props
var getChildren = function getChildren(element) {
  return element.props && element.props.children
    ? element.props.children
    : element.children
      ? element.children
      : undefined
}

// Preact uses "nodeName", React uses "type"
var getType = function getType(element) {
  return element.type || element.nodeName
}

// Preact uses "attributes", React uses "props"
var getProps = function getProps(element) {
  return element.props || element.attributes
}

var isReactElement = function isReactElement(element) {
  return !!getType(element)
}

var isClassComponent = function isClassComponent(Comp) {
  return (
    Comp.prototype &&
    (Comp.prototype.render ||
      Comp.prototype.isReactComponent ||
      Comp.prototype.isPureReactComponent)
  )
}

var isForwardRef = function isForwardRef(Comp) {
  return Comp.type && Comp.type.$$typeof === forwardRefSymbol
}

var providesChildContext = function providesChildContext(instance) {
  return !!instance.getChildContext
}

// Recurse a React Element tree, running the provided visitor against each element.
// If a visitor call returns `false` then we will not recurse into the respective
// elements children.
function reactTreeWalker(tree, visitor, context) {
  var options =
    arguments.length > 3 && arguments[3] !== undefined
      ? arguments[3]
      : defaultOptions

  return new Promise(function(resolve, reject) {
    var safeVisitor = function safeVisitor() {
      try {
        return visitor.apply(undefined, arguments)
      } catch (err) {
        reject(err)
      }
      return undefined
    }

    var recursive = function recursive(currentElement, currentContext) {
      if (Array.isArray(currentElement)) {
        return Promise.all(
          currentElement.map(function(item) {
            return recursive(item, currentContext)
          }),
        )
      }

      if (!currentElement) {
        return Promise.resolve()
      }

      if (
        typeof currentElement === 'string' ||
        typeof currentElement === 'number'
      ) {
        // Just visit these, they are leaves so we don't keep traversing.
        safeVisitor(currentElement, null, currentContext)
        return Promise.resolve()
      }

      if (currentElement.type) {
        var _context =
          currentElement.type._context ||
          (currentElement.type.Provider &&
            currentElement.type.Provider._context)

        if (_context) {
          if ('value' in currentElement.props) {
            // <Provider>
            // eslint-disable-next-line no-param-reassign
            currentElement.type._context._currentValue =
              currentElement.props.value
          }

          if (typeof currentElement.props.children === 'function') {
            // <Consumer>
            var el = currentElement.props.children(_context._currentValue)
            return recursive(el, currentContext)
          }
        }
      }

      if (isReactElement(currentElement)) {
        return new Promise(function(innerResolve) {
          var visitCurrentElement = function visitCurrentElement(
            render,
            compInstance,
            elContext,
            childContext,
          ) {
            return Promise.resolve(
              safeVisitor(
                currentElement,
                compInstance,
                elContext,
                childContext,
              ),
            )
              .then(function(result) {
                if (result !== false) {
                  // A false wasn't returned so we will attempt to visit the children
                  // for the current element.
                  var tempChildren = render()
                  var children = ensureChild(tempChildren)
                  if (children) {
                    if (Array.isArray(children)) {
                      // If its a react Children collection we need to breadth-first
                      // traverse each of them, and pMapSeries allows us to do a
                      // depth-first traversal that respects Promises. Thanks @sindresorhus!
                      return pMapSeries(children, function(child) {
                        return child
                          ? recursive(child, childContext)
                          : Promise.resolve()
                      })
                        .then(innerResolve, reject)
                        .catch(reject)
                    }
                    // Otherwise we pass the individual child to the next recursion.
                    return recursive(children, childContext)
                      .then(innerResolve, reject)
                      .catch(reject)
                  }
                }
                return undefined
              })
              .catch(reject)
          }

          if (
            typeof getType(currentElement) === 'function' ||
            isForwardRef(currentElement)
          ) {
            var Component = getType(currentElement)
            var props = Object.assign(
              {},
              Component.defaultProps,
              getProps(currentElement),
              // For Preact support so that the props get passed into render
              // function.
              {
                children: getChildren(currentElement),
              },
            )
            if (isForwardRef(currentElement)) {
              visitCurrentElement(
                function() {
                  return currentElement.type.render(props)
                },
                null,
                currentContext,
                currentContext,
              ).then(innerResolve)
            } else if (isClassComponent(Component)) {
              // Class component
              var instance = new Component(props, currentContext)

              // In case the user doesn't pass these to super in the constructor
              Object.defineProperty(instance, 'props', {
                value: instance.props || props,
              })
              instance.context = instance.context || currentContext
              // set the instance state to null (not undefined) if not set, to match React behaviour
              instance.state = instance.state || null

              // Make the setState synchronous.
              instance.setState = function(newState) {
                if (typeof newState === 'function') {
                  // eslint-disable-next-line no-param-reassign
                  newState = newState(
                    instance.state,
                    instance.props,
                    instance.context,
                  )
                }
                instance.state = Object.assign({}, instance.state, newState)
              }

              if (Component.getDerivedStateFromProps) {
                var result = Component.getDerivedStateFromProps(
                  instance.props,
                  instance.state,
                )
                if (result !== null) {
                  instance.state = Object.assign({}, instance.state, result)
                }
              } else if (instance.UNSAFE_componentWillMount) {
                instance.UNSAFE_componentWillMount()
              } else if (instance.componentWillMount) {
                instance.componentWillMount()
              }

              var childContext = providesChildContext(instance)
                ? Object.assign({}, currentContext, instance.getChildContext())
                : currentContext

              visitCurrentElement(
                // Note: preact API also allows props and state to be referenced
                // as arguments to the render func, so we pass them through
                // here
                function() {
                  return instance.render(instance.props, instance.state)
                },
                instance,
                currentContext,
                childContext,
              )
                .then(function() {
                  if (
                    options.componentWillUnmount &&
                    instance.componentWillUnmount
                  ) {
                    instance.componentWillUnmount()
                  }
                })
                .then(innerResolve)
            } else {
              // Stateless Functional Component
              visitCurrentElement(
                function() {
                  return Component(props, currentContext)
                },
                null,
                currentContext,
                currentContext,
              ).then(innerResolve)
            }
          } else {
            // A basic element, such as a dom node, string, number etc.
            visitCurrentElement(
              function() {
                return getChildren(currentElement)
              },
              null,
              currentContext,
              currentContext,
            ).then(innerResolve)
          }
        })
      }

      // Portals
      if (
        currentElement.containerInfo &&
        currentElement.children &&
        currentElement.children.props &&
        Array.isArray(currentElement.children.props.children)
      ) {
        return Promise.all(
          currentElement.children.props.children.map(function(child) {
            return recursive(child, currentContext)
          }),
        )
      }

      return Promise.resolve()
    }

    recursive(tree, context).then(resolve, reject)
  })
}

module.exports = reactTreeWalker
//# sourceMappingURL=react-tree-walker.js.map
