import { impossible } from "@calculemus/impossible";
import { Map, List, Set } from "immutable";
import * as ast from "../ast";
import { error } from "./error";
import { GlobalEnv, getTypeDef, getFunctionDeclaration, addDecl, initMain } from "./globalenv";
import { Env, equalFunctionTypes, checkTypeInDeclaration, checkFunctionReturnType } from "./types";
import { checkExpression } from "./expressions";
import { checkStatements } from "./statements";
import { expressionFreeVars, checkStatementFlow, checkExpressionUsesGetFreeFunctions } from "./flow";

function getDefinedFromParams(params: ast.VariableDeclarationOnly[]): Set<string> {
    return params.reduce((set, param) => set.add(param.id.name), Set<string>());
}

function getEnvironmentFromParams(genv: GlobalEnv, params: ast.VariableDeclarationOnly[]): Env {
    return params.reduce((env, param) => {
        checkTypeInDeclaration(genv, param.kind, true);
        if (env.has(param.id.name)) {
            return error(`variable ${param.id.name} declared twice`);
        } else {
            return env.set(param.id.name, param.kind);
        }
    }, Map<string, ast.Type>());
}

function checkDeclaration(genv: GlobalEnv, decl: ast.Declaration, library: boolean): Set<string> {
    switch (decl.tag) {
        case "Pragma": {
            return Set();
        }
        case "StructDeclaration": {
            return Set();
        }
        case "TypeDefinition": {
            const previousTypeDef = getTypeDef(genv, decl.definition.id.name);
            const previousFunction = getFunctionDeclaration(genv, decl.definition.id.name);
            if (previousTypeDef !== null)
                return error(`type name '${decl.definition.id.name}' already defined as a type`);
            if (previousFunction !== null)
                return error(
                    `type name '${decl.definition.id.name}' already used in a function ${
                        previousFunction.body === null ? "declaration" : "definition"
                    }`
                );
            return Set();
        }
        case "FunctionTypeDefinition": {
            const previousTypeDef = getTypeDef(genv, decl.definition.id.name);
            const previousFunction = getFunctionDeclaration(genv, decl.definition.id.name);
            if (previousTypeDef !== null)
                return error(`function type name '${decl.definition.id.name}' already defined as a type`);
            if (previousFunction !== null)
                return error(
                    `function type name '${decl.definition.id.name}' already used in a function ${
                        previousFunction.body === null ? "declaration" : "definition"
                    }`
                );
            checkFunctionReturnType(genv, decl.definition.returns);
            const env = getEnvironmentFromParams(genv, decl.definition.params);
            const defined = getDefinedFromParams(decl.definition.params);
            let functionsUsed = decl.definition.preconditions.reduce(
                (functionsUsed, anno) => {
                    checkExpression(genv, env, { tag: "@requires" }, anno, { tag: "BoolType" });
                    return functionsUsed.union(checkExpressionUsesGetFreeFunctions(defined, defined, anno));
                },
                decl.definition.postconditions.reduce((functionsUsed, anno) => {
                    checkExpression(genv, env, { tag: "@ensures", returns: decl.definition.returns }, anno, {
                        tag: "BoolType"
                    });
                    return functionsUsed.union(checkExpressionUsesGetFreeFunctions(defined, defined, anno));
                }, Set())
            );
            return functionsUsed;
        }
        case "FunctionDeclaration": {
            checkFunctionReturnType(genv, decl.returns);
            const env = getEnvironmentFromParams(genv, decl.params);
            const defined = getDefinedFromParams(decl.params);
            let functionsUsed = decl.preconditions.reduce(
                (functionsUsed, anno) => {
                    checkExpression(genv, env, { tag: "@requires" }, anno, { tag: "BoolType" });
                    return functionsUsed.union(checkExpressionUsesGetFreeFunctions(defined, defined, anno));
                },
                decl.postconditions.reduce((functionsUsed, anno) => {
                    checkExpression(genv, env, { tag: "@ensures", returns: decl.returns }, anno, {
                        tag: "BoolType"
                    });
                    return functionsUsed.union(checkExpressionUsesGetFreeFunctions(defined, defined, anno));
                }, Set())
            );

            const previousFunction = getFunctionDeclaration(genv, decl.id.name);
            if (previousFunction !== null) {
                if (previousFunction.body !== null && decl.body !== null)
                    error(`function ${decl.id.name} defined more than once`);
                if (!equalFunctionTypes(genv, previousFunction, decl)) {
                    const oldone = previousFunction.body === null ? "declaration" : "definition";
                    const newone = decl.body === null ? "declaration" : "definition";
                    error(
                        `function ${newone} for '${decl.id.name}' does not match previous function ${oldone}`
                    );
                }
            }

            if (decl.body !== null) {
                const recursiveGlobalEnv = addDecl(genv, {
                    tag: "FunctionDeclaration",
                    id: decl.id,
                    returns: decl.returns,
                    params: decl.params,
                    preconditions: [],
                    postconditions: [],
                    body: null
                });
                checkStatements(recursiveGlobalEnv, env, decl.body.body, decl.returns, false);
                let constants = decl.postconditions.reduce(
                    (constants, anno) => constants.union(expressionFreeVars(anno).intersect(defined)),
                    Set()
                );
                const functionAnalysis = checkStatementFlow(defined, constants, defined, decl.body);
                if (decl.returns.tag !== "VoidType" && !functionAnalysis.returns)
                    return error(
                        `function ${
                            decl.id.name
                        } has non-void return type but does not return along every path`
                    );
                functionsUsed = functionAnalysis.functions.union(functionsUsed);
            }

            return functionsUsed;
        }
        /* instanbul ignore next */
        default: {
            return impossible(decl as never);
        }
    }
}

export function checkProgram(libs: List<ast.Declaration>, decls: List<ast.Declaration>) {
    const libenv = libs.reduce(
        ({ genv, functionsUsed }, decl) => {
            const newFunctions = checkDeclaration(genv, decl, true);
            return {
                genv: addDecl(genv, decl),
                functionsUsed: newFunctions.union(functionsUsed)
            };
        },
        { genv: initMain, functionsUsed: Set<string>() }
    );

    const progenv = decls.reduce(({ genv, functionsUsed }, decl) => {
        const newFunctions = checkDeclaration(genv, decl, true);
        return {
            genv: addDecl(genv, decl),
            functionsUsed: newFunctions.union(functionsUsed)
        };
    }, libenv);

    progenv.functionsUsed.union(Set<string>(["main"])).forEach((name): void => {
        const def = getFunctionDeclaration(progenv.genv, name);
        if (def === null) return error(`No definition for ${name} (should be impossible, please report)`);
        if (def.body === null) return error(`function ${name} is never defined`);
    });
}
