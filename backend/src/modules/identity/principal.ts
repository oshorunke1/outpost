// Who is calling. Routes only ever trust what a guard put on request.principal.
export interface OperatorPrincipal {
  kind: 'operator';
  operatorId: string;
  sessionId: string;
  scopes: string[];
}

export interface ServicePrincipal {
  kind: 'service';
  clientId: string;
  scopes: string[];
}

export type Principal = OperatorPrincipal | ServicePrincipal;
