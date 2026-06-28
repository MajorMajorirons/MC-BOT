package com.dynamicmarket;

public class TransactionResult {
    public enum Status { SUCCESS, FAIL }

    private final Status status;
    private final String message;
    private final double totalAmount;
    private final double newItemPrice;

    private TransactionResult(Status status, String message, double totalAmount, double newItemPrice) {
        this.status = status;
        this.message = message;
        this.totalAmount = totalAmount;
        this.newItemPrice = newItemPrice;
    }

    public static TransactionResult success(String message, double totalAmount, double newItemPrice) {
        return new TransactionResult(Status.SUCCESS, message, totalAmount, newItemPrice);
    }

    public static TransactionResult fail(String message) {
        return new TransactionResult(Status.FAIL, message, 0, 0);
    }

    public boolean isSuccess()        { return status == Status.SUCCESS; }
    public String getMessage()        { return message; }
    public double getTotalAmount()    { return totalAmount; }
    public double getNewItemPrice()   { return newItemPrice; }
    public Status getStatus()         { return status; }
}
