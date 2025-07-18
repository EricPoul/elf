import {
  ClassDeclaration,
  ConstructorDeclaration,
  printNode,
  Project,
  QuoteKind,
  Scope,
  SourceFile,
  StructureKind,
  SyntaxKind,
  VariableDeclarationKind,
  ScriptTarget,
} from 'ts-morph';
import { CallExpression, factory } from 'typescript';
import { Options } from '../types';
import { names, resolveStoreVariableName } from '../utils';
import { ActiveIdBuilder } from './active-id.builder';
import { ActiveIdsBuilder } from './active-ids.builder';
import { EntitiesBuilder } from './entities.builder';
import { PropsBuilder } from './props.builder';
import { RequestsCacheBuilder } from './requests-cache.builder';
import { RequestsStatusBuilder } from './requests-status.builder';
import { UIEntitiesBuilder } from './ui-entities.builder';

export function createRepo(options: Options) {
  const { storeName } = options;
  const storeNames = names(storeName);
  const isFunctionTpl = !options.template || options.template === 'functions';
  const isStoreInlinedInClass = !isFunctionTpl && options.inlineStoreInClass;
  const classWithConstructor = isStoreInlinedInClass !== 'withoutConstructor';

  const project = new Project({
    manipulationSettings: {
      quoteKind: QuoteKind.Single,
    },
    compilerOptions: {
      target: ScriptTarget.ES2015,
    },
  });

  const sourceFile = project.createSourceFile(`repo.ts`, ``);

  const repoName = `${storeNames.className}Repository`;
  const repoClassDec = sourceFile.addClass({
    name: repoName,
    isExported: true,
  });
  let repoClassDecConstructor: ConstructorDeclaration | undefined;

  if (isStoreInlinedInClass && classWithConstructor) {
    repoClassDec.addConstructor();
    repoClassDecConstructor = repoClassDec.getConstructors()[0];
  }

  sourceFile.addImportDeclaration({
    moduleSpecifier: '@ngneat/elf',
    namedImports: ['createStore'].map((name) => ({
      kind: StructureKind.ImportSpecifier,
      name,
    })),
  });

  const builders = [
    RequestsCacheBuilder,
    RequestsStatusBuilder,
    ActiveIdBuilder,
    ActiveIdsBuilder,
    EntitiesBuilder,
    PropsBuilder,
    UIEntitiesBuilder,
  ];

  const propsFactories: CallExpression[] = [];

  for (const feature of options.features) {
    for (const Builder of builders) {
      if (Builder.supports(feature)) {
        const instance = new Builder(sourceFile, repoClassDec, options);
        instance.run();
        propsFactories.push(instance.getPropsFactory());
      }
    }
  }

  const storeOpts = factory.createIdentifier(
    `{ name: '${storeNames.propertyName}' }`,
  );

  const store = factory.createCallExpression(
    factory.createIdentifier('createStore'),
    undefined,
    [storeOpts, ...propsFactories],
  );

  if (isStoreInlinedInClass) {
    if (repoClassDecConstructor) {
      addInlineStoreToRepoClass({
        repoClassDec,
        repoClassDecConstructor,
        options,
        store,
        storeNames,
      });
    } else {
      addInlineStoreToRepoClassWithoutConstructor({
        repoClassDec,
        store,
      });
    }
  } else {
    addStoreToRepo({
      repoClassDec,
      options,
      store,
      storeNames,
      isFunctionTpl,
      sourceFile,
    });

    if (isFunctionTpl) {
      toFunctions(sourceFile, repoClassDec);
    }
  }

  if (options.hooks) {
    options.hooks.forEach((h) => h.post?.({ sourceFile, repoName, options }));
  }

  sourceFile.formatText({ indentSize: 2 });

  return sourceFile.getText();
}

function addStoreToRepo({
  repoClassDec: classDec,
  sourceFile,
  options,
  storeNames,
  store,
  isFunctionTpl,
}: {
  repoClassDec: ClassDeclaration;
  sourceFile: SourceFile;
  options: Options;
  storeNames: ReturnType<typeof names>;
  store: CallExpression;
  isFunctionTpl: boolean;
}) {
  const repoPosition = classDec.getChildIndex();

  sourceFile.insertVariableStatement(repoPosition, {
    declarationKind: VariableDeclarationKind.Const,
    isExported: isFunctionTpl,
    declarations: [
      {
        name: resolveStoreVariableName(options.template, storeNames),
        initializer: printNode(store),
      },
    ],
  });
}

function addInlineStoreToRepoClass({
  repoClassDec: classDec,
  repoClassDecConstructor: constructorDec,
  options,
  storeNames,
  store,
}: {
  repoClassDec: ClassDeclaration;
  repoClassDecConstructor: ConstructorDeclaration;
  options: Options;
  storeNames: ReturnType<typeof names>;
  store: CallExpression;
}) {
  const storeName = resolveStoreVariableName(
    options.template,
    storeNames,
    true,
  );
  const lastPropertyIndex = classDec
    .getLastChildByKind(SyntaxKind.PropertyDeclaration)
    ?.getChildIndex();
  const propertyIndex = lastPropertyIndex
    ? lastPropertyIndex + 1
    : constructorDec.getChildIndex();

  const createStoreMethodName = addCreateStoreMethod({
    repoClassDec: classDec,
    store,
  });

  constructorDec.insertStatements(
    0,
    `${storeName} = this.${createStoreMethodName}();`,
  );

  const storeProperty = classDec.insertProperty(propertyIndex, {
    name: `${resolveStoreVariableName(options.template, storeNames)}`,
    scope: Scope.Private,
  });

  if (propertyIndex > 0) {
    storeProperty?.prependWhitespace('\n');
  }
}

function addInlineStoreToRepoClassWithoutConstructor({
  repoClassDec: classDec,
  store,
}: {
  repoClassDec: ClassDeclaration;
  store: CallExpression;
}) {
  const createStoreMethodName = addCreateStoreMethod({
    repoClassDec: classDec,
    store,
  });

  classDec.insertProperty(0, {
    name: 'store',
    scope: Scope.Private,
    isReadonly: true,
    initializer: `this.${createStoreMethodName}()`,
  });

  classDec.insertMember(1, '\n');
}

function toFunctions(sourceFile: SourceFile, classDec: ClassDeclaration) {
  const exported: string[] = [];

  classDec?.getProperties().forEach((p) => {
    exported.push(`export const ${p.getText()}`);
  });

  classDec?.getMethods().forEach((m) => {
    exported.push(`export function ${m.getText()}`);
  });

  classDec?.remove();

  sourceFile.replaceWithText(
    `${sourceFile.getText()}\n ${exported.join('\n\n')}`,
  );
}

function addCreateStoreMethod({
  repoClassDec: classDec,
  store,
}: {
  repoClassDec: ClassDeclaration;
  store: CallExpression;
}): string {
  const createStoreMethodName = 'createStore';

  classDec.addMethod({
    name: createStoreMethodName,
    returnType: `typeof store`,
    scope: Scope.Private,
    statements: (writer) => {
      writer.writeLine(`const store = ${printNode(store)};`);
      writer.blankLine();
      writer.writeLine(`return store;`);
    },
  });

  return createStoreMethodName;
}
