declare module 'jazzcash-checkout' {
  export type JazzCashEnvironment = 'sandbox' | 'live';

  export type JazzCashCredentials = {
    config: {
      merchantId: string;
      password: string;
      hashKey: string;
    };
    environment?: JazzCashEnvironment;
  };

  export type JazzCashData = {
    pp_Version?: string;
    pp_TxnType?: string;
    pp_Language?: string;
    pp_ReturnURL?: string;
    pp_BankID?: string;
    pp_ProductID?: string;
    pp_TxnRefNo?: string;
    pp_Amount: number;
    pp_TxnCurrency?: string;
    pp_TxnDateTime?: string;
    pp_BillReference?: string;
    pp_Description?: string;
    pp_TxnExpiryDateTime?: string;
    ppmpf_1?: string;
    ppmpf_2?: string;
    ppmpf_3?: string;
    ppmpf_4?: string;
    ppmpf_5?: string;
    pp_MobileNumber?: string;
    pp_CNIC?: string;
  };

  export type JazzCashRequestType = 'PAY' | 'WALLET' | 'INQUIRY' | 'REFUND';
  export type JazzCashPayload = Record<string, string | number>;

  const Jazzcash: {
    credentials(credentials: JazzCashCredentials): void;
    setData(data: JazzCashData): void;
    createRequest(request: 'PAY'): Promise<JazzCashPayload>;
    createRequest(request: Exclude<JazzCashRequestType, 'PAY'>): Promise<string>;
  };

  export default Jazzcash;
}
