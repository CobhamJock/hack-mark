package com.octocat.supply.exception;

public class PaymentException extends ApiException {
    private final int status;

    public PaymentException(int status, String code, String message) {
        super(code, message);
        this.status = status;
    }

    public int getStatus() {
        return status;
    }
}
